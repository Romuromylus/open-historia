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

// Coerce one Stage 2 batch reply into clean impact entries. eventIndex is the
// GLOBAL index the model was shown; anything outside [batchStart, batchStart+
// batchLength) is junk from a confused model and is dropped, as is a duplicate
// index (first entry wins). An empty result is perfectly valid — a calm batch
// legitimately produces no impacts.
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
      regionTransfers: asArray(entry.regionTransfers),
      polityChanges: asArray(entry.polityChanges),
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
// Region-vocabulary grounding + resolver-feedback repair (Stage 2 support).
//
// The Stage-1 narrative names places with era-appropriate or poetic labels
// ("the Thracesian theme", "Philadelphia") while the map catalog carries modern
// GADM admin names ("Aydın", "Denizli"). Stage 2 therefore emits regionTransfers
// the resolver can't match, and every sub-national conquest silently drops. The
// helpers below (all pure, no .jsx) (a) build the real region vocabulary shown to
// the encoder and (b) drive a one-shot repair call over whatever still fails to
// resolve. Anything needing loadRegionCatalog/loadCountryNames lives in
// gameplay.js and delegates here.
// ---------------------------------------------------------------------------

const trimStr = (value) => String(value ?? "").trim();
const foldStr = (value) => trimStr(value).toLowerCase();
const escapeRegExp = (value) => trimStr(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A region's CURRENT owner — the live override when present, else the stock
// map's country code. Mirrors regionTransferResolver.js's currentOwner so the
// vocabulary and candidate lists agree with what the resolver will actually do.
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

// Which polities does a batch's prose mention? Scans text for each entry's
// display name / alias (case-insensitive substring, length ≥ 3) or its code
// (whole-word, case-insensitive). Returns codes in catalog order, deduped.
// polityEntries: [{ code, name, aliases? }].
export const detectPolityCodes = (text, polityEntries) => {
  const haystack = foldStr(text);
  if (!haystack) return [];
  const out = [];
  const seen = new Set();
  for (const entry of asArray(polityEntries)) {
    if (!entry) continue;
    const code = trimStr(entry.code);
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue;

    let hit = false;
    const name = foldStr(entry.name);
    if (name.length >= 3 && haystack.includes(name)) hit = true;
    if (!hit) {
      for (const alias of asArray(entry.aliases)) {
        const folded = foldStr(alias);
        if (folded.length >= 3 && haystack.includes(folded)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit && code.length >= 2 && new RegExp(`\\b${escapeRegExp(code)}\\b`, "i").test(text)) {
      hit = true;
    }
    if (hit) {
      seen.add(key);
      out.push(code);
    }
  }
  return out;
};

// Decide which polities' region vocabulary a batch needs: ALWAYS the player,
// then every polity the batch mentions. If that yields fewer than minPolities,
// top up from fallbackCodes (catalog order). Capped at maxPolities.
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

// One polity's held-region list for the Stage-2 vocabulary block. Caps the list
// and reports the overflow count so the encoder knows more regions resolve too.
export const formatPolityRegionVocabulary = ({ code, name, regions, cap = 50 } = {}) => {
  const list = asArray(regions).filter((region) => region?.id);
  const label = trimStr(name) ? `${trimStr(name)} (${trimStr(code)})` : trimStr(code);
  const header = `REGIONS HELD BY ${label} — partial transfers MUST name regions from this list exactly:`;
  if (list.length === 0) {
    return `${header}\n  (no regions currently attributed to this polity on the map)`;
  }
  const shown = list.slice(0, cap);
  const lines = shown.map((region) => `- ${region.name || region.id} [${region.id}]`);
  const remaining = list.length - shown.length;
  if (remaining > 0) {
    lines.push(`…and ${remaining} more (any of this polity's other regions also resolve by exact name)`);
  }
  return `${header}\n${lines.join("\n")}`;
};

// Full Stage-2 vocabulary block: one formatPolityRegionVocabulary section per
// polity code. nameByCode maps an upper-cased code to its display name.
export const buildRegionVocabularyBlock = ({
  polityCodes = [],
  regions = [],
  ownership = {},
  nameByCode = new Map(),
  regionCap = 50,
} = {}) => {
  const names = nameByCode instanceof Map ? nameByCode : new Map(Object.entries(nameByCode ?? {}));
  const blocks = asArray(polityCodes).map((code) =>
    formatPolityRegionVocabulary({
      code,
      name: names.get(trimStr(code).toUpperCase()) || code,
      regions: holdingsForCode(regions, ownership, code),
      cap: regionCap,
    }),
  );
  return blocks.join("\n\n");
};

// Candidate regions for repairing ONE unresolved transfer: the fromCode
// polity's current holdings (cap holdingsCap) PLUS catalog regions whose name
// shares a whole-word token with the requested regionName (cap tokenCap).
// Deduped by id; returns compact {id, name, country, countryCode} rows.
export const buildRepairCandidates = (
  entry,
  { regions = [], ownership = {}, holdingsCap = 50, tokenCap = 20, minTokenLen = 4 } = {},
) => {
  const out = [];
  const seen = new Set();
  const add = (region) => {
    if (!region?.id || seen.has(region.id)) return;
    seen.add(region.id);
    out.push({
      id: region.id,
      name: region.name || "",
      country: region.country || "",
      countryCode: region.countryCode || "",
    });
  };

  const fromCode = trimStr(entry?.fromCode);
  if (fromCode) {
    for (const region of holdingsForCode(regions, ownership, fromCode).slice(0, holdingsCap)) add(region);
  }

  const requested = trimStr(entry?.regionName) || trimStr(entry?.regionId);
  if (requested) {
    let added = 0;
    for (const region of asArray(regions)) {
      if (added >= tokenCap) break;
      if (!region?.id || seen.has(region.id)) continue;
      if (sharesNameToken(requested, region.name, minTokenLen)) {
        add(region);
        added += 1;
      }
    }
  }
  return out;
};

// eventIndex -> regionTransfers[] from an array of impact-ish entries.
const indexTransfers = (entries) => {
  const map = new Map();
  for (const entry of asArray(entries)) {
    const idx = toInt(entry?.eventIndex);
    if (idx === null) continue;
    if (!map.has(idx)) map.set(idx, asArray(entry.regionTransfers));
  }
  return map;
};

const asIndexMap = (value) => {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return indexTransfers(value);
  const map = new Map();
  for (const [key, val] of Object.entries(value ?? {})) {
    const idx = toInt(key);
    if (idx !== null) map.set(idx, asArray(val));
  }
  return map;
};

// Fold a repair reply back into a batch's impact entries. For every eventIndex
// the repair reply covers, that event's regionTransfers become its originally
// RESOLVED transfers (resolvedByIndex) PLUS the corrected repair transfers — the
// unresolved originals are dropped. Events the repair reply does NOT mention are
// returned unchanged (their originals survive to the final resolver pass).
//   - originalEntries: the batch's normalized impact entries
//   - resolvedByIndex: Map/obj/array — eventIndex -> transfers that resolved
//   - repairEntries: the parsed repair reply (array of {eventIndex, regionTransfers})
export const mergeRepairedTransfers = (originalEntries, resolvedByIndex, repairEntries) => {
  const resolved = asIndexMap(resolvedByIndex);
  const repaired = asIndexMap(repairEntries);
  return asArray(originalEntries).map((entry) => {
    const idx = toInt(entry?.eventIndex);
    if (idx === null || !repaired.has(idx)) return entry;
    const kept = resolved.has(idx) ? asArray(resolved.get(idx)) : [];
    return { ...entry, regionTransfers: [...kept, ...asArray(repaired.get(idx))] };
  });
};
