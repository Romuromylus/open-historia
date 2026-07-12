/*! Pax Colonia — staged turn pipeline (pure helpers, no .jsx imports). */
//
// These helpers back the two-stage jump pipeline in gameplay.js. They are kept
// in their OWN module, deliberately free of any .jsx import (gameplay.js pulls
// in ./main.jsx, which drags the browser/React world in and makes the file
// unloadable under `node --test`). Everything here is pure and synchronous so
// it can be unit-tested directly (see turnPipeline.test.js).

const asArray = (value) => (Array.isArray(value) ? value : []);

const toInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const EMPTY_IMPACTS = () => ({
  regionTransfers: [],
  polityChanges: [],
  ledgerChanges: [],
  unitOps: [],
  createdChats: [],
});

// Split a flat event list into fixed-size batches (used to fan Stage 2 impact
// calls out with Promise.all). A batch's GLOBAL start index is batchIndex*size,
// which the caller relies on to key impacts back to the whole-turn event list.
export const chunkEvents = (events, size) => {
  const list = asArray(events);
  const step = Number.isFinite(size) && size > 0 ? Math.trunc(size) : 10;
  const batches = [];
  for (let i = 0; i < list.length; i += step) {
    batches.push(list.slice(i, i + step));
  }
  return batches;
};

// Stage 1 acceptance check. A parsed object must carry at least one event and
// every event must have a title. A VALID-but-EMPTY turn (no events) is treated
// as a FAILED attempt, not a silent "nothing happened" — see simulateTimelineJump.
export const validateNarrativePayload = (parsed) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "response was not a JSON object" };
  }

  const events = parsed.events;
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: "no events were returned" };
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { ok: false, reason: `event ${i + 1} was not an object` };
    }
    const title = typeof event.title === "string" ? event.title.trim() : "";
    if (!title) {
      return { ok: false, reason: `event ${i + 1} is missing a title` };
    }
  }

  return { ok: true, reason: "" };
};

// The per-turn territorial adjudicator (a SEPARATE call — see gameplay.js) now
// owns every region transfer and annexation. The Stage-2 impact encoder must not
// move borders, so strip the two things it might still emit that would collide
// with the adjudicator: a whole regionTransfers list (dropped outright), and the
// status/absorbedBy of any polityChange (a rename/recolor is still fine, but a
// stale prompt pack must not be able to annex a polity behind the adjudicator's
// back). Purely defensive — the current jumpImpacts prompt no longer asks for
// either, but a scenario-bundled pack could.
const stripEncoderTerritory = (polityChange) => {
  if (!polityChange || typeof polityChange !== "object" || Array.isArray(polityChange)) {
    return polityChange;
  }
  const { status, absorbedBy, ...rest } = polityChange;
  return rest;
};

// Coerce one Stage 2 batch reply into clean impact entries. eventIndex is the
// GLOBAL index the model was shown; anything outside [batchStart, batchStart+
// batchLength) is junk from a confused model and is dropped, as is a duplicate
// index (first entry wins). An empty result is perfectly valid — a calm batch
// legitimately produces no impacts. regionTransfers are always emptied and
// polityChanges are stripped of status/absorbedBy (see stripEncoderTerritory).
export const normalizeImpactsPayload = (parsed, batchStart = 0, batchLength = Infinity) => {
  const start = toInt(batchStart) ?? 0;
  const length = Number.isFinite(batchLength) ? Math.max(0, Math.trunc(batchLength)) : Infinity;
  const end = Number.isFinite(length) ? start + length : Infinity;

  const source = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.impacts)
      ? parsed.impacts
      : [];

  const seen = new Set();
  const out = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const idx = toInt(entry.eventIndex);
    if (idx === null) continue;
    if (idx < start || idx >= end) continue; // out-of-range guard
    if (seen.has(idx)) continue; // duplicate index — keep the first
    seen.add(idx);
    out.push({
      eventIndex: idx,
      // Territory belongs to the adjudicator now — never trust encoder transfers.
      regionTransfers: [],
      polityChanges: asArray(entry.polityChanges).map(stripEncoderTerritory),
      ledgerChanges: asArray(entry.ledgerChanges),
      unitOps: asArray(entry.unitOps),
      createdChats: asArray(entry.createdChats),
    });
  }
  return out;
};

// Fold Stage 2 impact entries back onto the Stage 1 events by global index.
// Every event ends up with a full impacts object (empty arrays for events no
// batch mentioned), so the merged list drops straight into applySimulationResult.
export const mergeImpactsByIndex = (events, impactEntries) => {
  const list = asArray(events);
  const byIndex = new Map();
  for (const entry of asArray(impactEntries)) {
    const idx = toInt(entry?.eventIndex);
    if (idx === null || idx < 0 || idx >= list.length) continue;
    if (byIndex.has(idx)) continue; // first wins across batches
    byIndex.set(idx, entry);
  }

  return list.map((event, index) => {
    const entry = byIndex.get(index);
    return {
      ...event,
      impacts: entry
        ? {
            regionTransfers: asArray(entry.regionTransfers),
            polityChanges: asArray(entry.polityChanges),
            ledgerChanges: asArray(entry.ledgerChanges),
            unitOps: asArray(entry.unitOps),
            createdChats: asArray(entry.createdChats),
          }
        : EMPTY_IMPACTS(),
    };
  });
};

// ---------------------------------------------------------------------------
// Territorial adjudicator support (WP7): a closed-menu region-ownership pass.
//
// The Stage-1 narrative names places with era-appropriate or poetic labels
// ("the Thracesian theme", "Philadelphia") while the map catalog carries modern
// GADM admin names ("Aydın", "Denizli"). Instead of asking a model to WRITE
// region names (the fragile string-resolver chain the user rejected), a per-turn
// adjudicator PICKS from a numbered menu of the regions each relevant polity
// actually holds. These helpers (all pure, no .jsx) build that menu and resolve
// the adjudicator's menu-key picks into already-catalog-true transfers. Anything
// needing loadRegionCatalog/loadCountryNames lives in gameplay.js and delegates
// here.
// ---------------------------------------------------------------------------

const trimStr = (value) => String(value ?? "").trim();
// Case- AND diacritic-insensitive fold: prose says "Rûm"/"Aydın", catalogs and
// aliases say "Rum"/"Aydin" — both sides must land on the same string.
const foldStr = (value) =>
  trimStr(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const escapeRegExp = (value) => trimStr(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A region's CURRENT owner — the live override when present, else the stock
// map's country code. Mirrors regionTransferResolver.js's currentOwner so the
// menu agrees with what the apply-time resolver will actually do.
export const regionOwnerCode = (region, ownership = {}) =>
  trimStr(ownership?.[region?.id] ?? region?.countryCode ?? "");

// Every region the given polity code currently holds (by regionOwnerCode).
export const holdingsForCode = (regions, ownership, code) => {
  const target = foldStr(code);
  if (!target) return [];
  return asArray(regions).filter(
    (region) => region?.id && foldStr(regionOwnerCode(region, ownership)) === target,
  );
};

// Whole-word tokens of a place name: lowercased alphanumeric runs of length ≥
// minLen. Used to bridge an archaic/poetic narrated name to a catalog region.
export const nameTokens = (value, minLen = 4) => {
  const set = new Set();
  for (const raw of foldStr(value).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= minLen) set.add(raw);
  }
  return set;
};

// Do two names share at least one whole-word token (length ≥ minLen)?
export const sharesNameToken = (a, b, minLen = 4) => {
  const tokensA = nameTokens(a, minLen);
  if (tokensA.size === 0) return false;
  for (const token of nameTokens(b, minLen)) {
    if (tokensA.has(token)) return true;
  }
  return false;
};

// Word-bounded occurrence count of a (folded) needle in the (folded) haystack.
// Boundaries are non-letter/non-digit so "Rum" counts in "the Rum frontier" but
// not inside "instrument"; multi-word names count as phrases.
const countWordMatches = (haystack, needle) => {
  if (!needle || needle.length < 3) return 0;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "gu");
  return (haystack.match(re) ?? []).length;
};

// Which polities does the turn's prose mention — RANKED by how often? Counts
// word-bounded occurrences of each entry's display name, aliases and code
// (diacritic/case-folded). Ranking matters because the menu downstream is
// CAPPED: the war partner mentioned in half the events must outrank a European
// power name-dropped once in a flavor line, or it falls off the menu and the
// adjudicator physically cannot transfer its land (the exact bug found in a
// live save). Suffixed/inflected forms that a word-bounded count misses still
// register via a substring fallback worth a single mention.
// polityEntries: [{ code, name, aliases? }].
export const detectPolityCodes = (text, polityEntries) => {
  const haystack = foldStr(text);
  if (!haystack) return [];
  const ranked = [];
  const seen = new Set();
  for (const entry of asArray(polityEntries)) {
    if (!entry) continue;
    const code = trimStr(entry.code);
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let count = 0;
    const names = [entry.name, ...asArray(entry.aliases)];
    for (const raw of names) {
      count += countWordMatches(haystack, foldStr(raw));
    }
    if (code.length >= 2) {
      count += countWordMatches(haystack, foldStr(code));
    }
    if (count === 0) {
      // Substring fallback preserves the old recall (e.g. "Rhomanian" for the
      // alias "Rhomania") without letting it inflate the ranking.
      for (const raw of names) {
        const folded = foldStr(raw);
        if (folded.length >= 3 && haystack.includes(folded)) {
          count = 1;
          break;
        }
      }
    }
    if (count > 0) {
      ranked.push({ code, count });
    }
  }
  // Stable sort: equal counts keep catalog order.
  ranked.sort((a, b) => b.count - a.count);
  return ranked.map((entry) => entry.code);
};

// Decide which polities' region menu the turn needs: ALWAYS the player, then
// every polity the prose mentions. If that yields fewer than minPolities, top up
// from fallbackCodes (catalog order). Capped at maxPolities.
export const selectBatchPolities = ({
  batchText = "",
  polityEntries = [],
  playerCode = "",
  fallbackCodes = [],
  minPolities = 2,
  maxPolities = 6,
} = {}) => {
  const ordered = [];
  const seen = new Set();
  const add = (value) => {
    const code = trimStr(value);
    if (!code) return;
    const key = code.toUpperCase();
    if (seen.has(key) || ordered.length >= maxPolities) return;
    seen.add(key);
    ordered.push(code);
  };

  add(playerCode);
  for (const code of detectPolityCodes(batchText, polityEntries)) add(code);
  if (ordered.length < minPolities) {
    for (const code of asArray(fallbackCodes)) add(code);
  }
  return ordered.slice(0, maxPolities);
};

// Build the closed REGION MENU the adjudicator picks from. For each polity code,
// its currently-held regions are listed as GLOBALLY-numbered `R<N>` entries
// (unique across the whole menu). Returns { text, byKey } where byKey resolves a
// menu key `R<N>` (upper-cased) AND each listed region's exact id (upper-cased)
// to { regionId, ownerCode }. Caps regionCap regions per polity with an overflow
// note so the model knows the polity's other regions are also fair game.
export const buildRegionMenu = ({
  polityCodes = [],
  regions = [],
  ownership = {},
  nameByCode = new Map(),
  regionCap = 50,
} = {}) => {
  const names = nameByCode instanceof Map ? nameByCode : new Map(Object.entries(nameByCode ?? {}));
  const nameOf = (code) => names.get(trimStr(code).toUpperCase()) || trimStr(code);
  const byKey = new Map();
  const sections = [];
  let counter = 0;

  for (const rawCode of asArray(polityCodes)) {
    const code = trimStr(rawCode);
    if (!code) continue;
    const label = nameOf(code) ? `${nameOf(code)} (${code})` : code;
    const held = holdingsForCode(regions, ownership, code);
    if (held.length === 0) {
      sections.push(`${label} — holds no regions on the current map.`);
      continue;
    }
    const shown = held.slice(0, regionCap);
    const lines = [];
    for (const region of shown) {
      counter += 1;
      const key = `R${counter}`;
      const ownerCode = regionOwnerCode(region, ownership);
      const record = { regionId: region.id, ownerCode };
      byKey.set(key.toUpperCase(), record);
      byKey.set(trimStr(region.id).toUpperCase(), record);
      lines.push(`${key}: ${region.name || region.id} [${region.id}] — held by ${label}`);
    }
    const remaining = held.length - shown.length;
    if (remaining > 0) {
      lines.push(`…and ${remaining} more region(s) held by ${label} not listed here.`);
    }
    sections.push(`${label} holds:\n${lines.join("\n")}`);
  }

  return { text: sections.join("\n\n"), byKey };
};

// Resolve the adjudicator's parsed reply against the menu. `region` accepts a
// menu key (R<N>, case-insensitive) or an exact region id present in byKey;
// unknown keys are dropped. toCode/absorbedBy must be in validCodes (case-
// normalized to the catalog's canonical casing). An out-of-range eventIndex is
// re-attached to the LAST event rather than dropped — a real conquest should not
// vanish over an index slip. Region ids are deduped (first pick wins).
export const resolveAdjudication = (parsed, { byKey, eventCount, validCodes } = {}) => {
  const keys = byKey instanceof Map ? byKey : new Map(Object.entries(byKey ?? {}));
  const codeCanon = new Map();
  for (const raw of asArray(validCodes)) {
    const code = trimStr(raw);
    if (code) codeCanon.set(code.toUpperCase(), code);
  }
  const validCode = (value) => codeCanon.get(trimStr(value).toUpperCase()) || "";

  const count = Number.isFinite(eventCount) ? Math.max(0, Math.trunc(eventCount)) : 0;
  const lastIndex = count > 0 ? count - 1 : 0;
  const clampIndex = (raw) => {
    const idx = toInt(raw);
    if (idx === null || idx < 0 || idx >= count) return lastIndex;
    return idx;
  };

  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const transfers = [];
  const annexations = [];
  const seenRegion = new Set();
  const seenAnnex = new Set();
  let dropped = 0;

  for (const entry of asArray(source.transfers)) {
    if (!entry || typeof entry !== "object") {
      dropped += 1;
      continue;
    }
    const lookup = keys.get(trimStr(entry.region).toUpperCase());
    const toCode = validCode(entry.toCode);
    if (!lookup || !toCode) {
      dropped += 1;
      continue;
    }
    if (seenRegion.has(lookup.regionId)) {
      dropped += 1;
      continue;
    }
    seenRegion.add(lookup.regionId);
    transfers.push({
      eventIndex: clampIndex(entry.eventIndex),
      regionId: lookup.regionId,
      fromCode: lookup.ownerCode,
      toCode,
    });
  }

  for (const entry of asArray(source.annexations)) {
    if (!entry || typeof entry !== "object") {
      dropped += 1;
      continue;
    }
    const code = validCode(entry.code);
    const absorbedBy = validCode(entry.absorbedBy);
    if (!code || !absorbedBy) {
      dropped += 1;
      continue;
    }
    const key = code.toUpperCase();
    if (seenAnnex.has(key)) {
      dropped += 1;
      continue;
    }
    seenAnnex.add(key);
    annexations.push({ eventIndex: clampIndex(entry.eventIndex), code, absorbedBy });
  }

  return { transfers, annexations, dropped };
};

// Step-A ("conflict scan") payload of the two-step adjudication: WHICH polities
// gained or lost territory this turn, plus outright annexations. The model does
// this detection semantically — client-side alias matching mis-ranked the
// player's actual war partner off a capped menu in a live save (the HRE's
// generic alias "Empire" swallowed every "Byzantine Empire" mention). Codes are
// canonicalized against the roster; junk drops; parties are capped.
export const normalizePartiesPayload = (parsed, { validCodes = [], eventCount = 0, maxParties = 8 } = {}) => {
  const codeCanon = new Map();
  for (const raw of asArray(validCodes)) {
    const code = trimStr(raw);
    if (code) codeCanon.set(code.toUpperCase(), code);
  }
  const validCode = (value) => codeCanon.get(trimStr(value).toUpperCase()) || "";

  const count = Number.isFinite(eventCount) ? Math.max(0, Math.trunc(eventCount)) : 0;
  const lastIndex = count > 0 ? count - 1 : 0;
  const clampIndex = (raw) => {
    const idx = toInt(raw);
    if (idx === null || idx < 0 || idx >= count) return lastIndex;
    return idx;
  };

  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const cap = Number.isFinite(maxParties) && maxParties > 0 ? Math.trunc(maxParties) : 8;
  const parties = [];
  const seen = new Set();
  for (const raw of asArray(source.parties)) {
    const code = validCode(raw);
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key) || parties.length >= cap) continue;
    seen.add(key);
    parties.push(code);
  }

  const annexations = [];
  const seenAnnex = new Set();
  for (const entry of asArray(source.annexations)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const code = validCode(entry.code);
    const absorbedBy = validCode(entry.absorbedBy);
    if (!code || !absorbedBy) continue;
    const key = code.toUpperCase();
    if (seenAnnex.has(key)) continue;
    seenAnnex.add(key);
    annexations.push({ absorbedBy, code, eventIndex: clampIndex(entry.eventIndex) });
  }

  return { annexations, parties };
};

// Expand a whole-polity annexation into per-region transfers: every region the
// losing polity currently holds (currentOwner = override ?? countryCode) moves
// to absorbedBy, plus a polityChanges entry flipping the loser to "annexed".
export const expandAnnexation = (code, { regions = [], ownership = {}, absorbedBy = "" } = {}) => {
  const victor = trimStr(absorbedBy);
  const loser = trimStr(code);
  const transfers = holdingsForCode(regions, ownership, loser).map((region) => ({
    regionId: region.id,
    regionName: region.name || "",
    fromCode: regionOwnerCode(region, ownership),
    toCode: victor,
  }));
  const polityChanges = [{ code: loser, status: "annexed", absorbedBy: victor }];
  return { transfers, polityChanges };
};

// Merge a resolved adjudication into the Stage-1 events by eventIndex. Transfers
// append to that event's impacts.regionTransfers as ALREADY-RESOLVED entries
// (real catalog id + name); annexation events additionally get the expanded
// transfers and the "annexed" polityChanges entry. Existing impacts (Stage-2
// ledger/unit/chat) are preserved. Ownership is the pre-turn snapshot — the
// apply-time resolver re-threads it event-by-event and skips already-owned land.
export const mergeAdjudicationIntoEvents = (events, resolution, { regions = [], ownership = {} } = {}) => {
  const list = asArray(events);
  if (list.length === 0) return list;

  const nameById = new Map(asArray(regions).map((region) => [trimStr(region?.id), region?.name || ""]));
  const additions = new Map(); // idx -> { regionTransfers:[], polityChanges:[] }
  const bucket = (idx) => {
    if (!additions.has(idx)) additions.set(idx, { regionTransfers: [], polityChanges: [] });
    return additions.get(idx);
  };

  const { transfers = [], annexations = [] } =
    resolution && typeof resolution === "object" ? resolution : {};

  for (const transfer of asArray(transfers)) {
    const idx = toInt(transfer?.eventIndex);
    if (idx === null || idx < 0 || idx >= list.length) continue;
    bucket(idx).regionTransfers.push({
      regionId: transfer.regionId,
      regionName: nameById.get(trimStr(transfer.regionId)) || "",
      fromCode: transfer.fromCode || "",
      toCode: transfer.toCode || "",
    });
  }

  for (const annex of asArray(annexations)) {
    const idx = toInt(annex?.eventIndex);
    if (idx === null || idx < 0 || idx >= list.length) continue;
    const { transfers: annexTransfers, polityChanges } = expandAnnexation(annex.code, {
      regions,
      ownership,
      absorbedBy: annex.absorbedBy,
    });
    const b = bucket(idx);
    for (const t of annexTransfers) b.regionTransfers.push(t);
    for (const change of polityChanges) b.polityChanges.push(change);
  }

  return list.map((event, index) => {
    const add = additions.get(index);
    if (!add) return event;
    const baseImpacts = event.impacts && typeof event.impacts === "object" ? event.impacts : {};
    return {
      ...event,
      impacts: {
        ...baseImpacts,
        regionTransfers: [...asArray(baseImpacts.regionTransfers), ...add.regionTransfers],
        polityChanges: [...asArray(baseImpacts.polityChanges), ...add.polityChanges],
      },
    };
  });
};
