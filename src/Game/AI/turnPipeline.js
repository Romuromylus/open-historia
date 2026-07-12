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
