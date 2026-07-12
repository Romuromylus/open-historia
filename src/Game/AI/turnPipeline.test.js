import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chunkEvents,
  mergeImpactsByIndex,
  normalizeImpactsPayload,
  validateNarrativePayload,
} from "./turnPipeline.js";

const makeEvents = (n) =>
  Array.from({ length: n }, (_, i) => ({ title: `Event ${i}`, description: `d${i}`, date: "1500-01-01" }));

describe("chunkEvents", () => {
  it("splits an exact multiple of the batch size into full batches", () => {
    const batches = chunkEvents(makeEvents(20), 10);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 10);
    assert.equal(batches[1].length, 10);
  });

  it("keeps a short trailing batch", () => {
    const batches = chunkEvents(makeEvents(23), 10);
    assert.deepEqual(batches.map((b) => b.length), [10, 10, 3]);
  });

  it("returns a single batch when fewer events than the size", () => {
    const batches = chunkEvents(makeEvents(4), 10);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 4);
  });

  it("returns no batches for an empty list", () => {
    assert.deepEqual(chunkEvents([], 10), []);
    assert.deepEqual(chunkEvents(null, 10), []);
  });

  it("falls back to a default size when given a bad size", () => {
    assert.equal(chunkEvents(makeEvents(15), 0).length, 2); // default 10
    assert.equal(chunkEvents(makeEvents(15), -3).length, 2);
    assert.equal(chunkEvents(makeEvents(15), NaN).length, 2);
  });
});

describe("validateNarrativePayload", () => {
  it("accepts a well-formed payload with titled events", () => {
    const result = validateNarrativePayload({ events: [{ title: "A war begins" }] });
    assert.equal(result.ok, true);
  });

  it("rejects a non-object", () => {
    assert.equal(validateNarrativePayload(null).ok, false);
    assert.equal(validateNarrativePayload("nope").ok, false);
    assert.equal(validateNarrativePayload([]).ok, false);
  });

  it("rejects a payload with no events (a valid-but-empty turn is a failure)", () => {
    assert.equal(validateNarrativePayload({ events: [] }).ok, false);
    assert.equal(validateNarrativePayload({ summary: "quiet" }).ok, false);
  });

  it("rejects when any event is missing a title", () => {
    const result = validateNarrativePayload({ events: [{ title: "ok" }, { description: "no title" }] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /event 2/);
  });

  it("rejects when an event is not an object", () => {
    assert.equal(validateNarrativePayload({ events: ["just a string"] }).ok, false);
  });
});

describe("normalizeImpactsPayload", () => {
  it("keeps in-range entries and defaults every impact array", () => {
    const out = normalizeImpactsPayload(
      { impacts: [{ eventIndex: 0, regionTransfers: [{ toCode: "POL" }] }] },
      0,
      10,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].eventIndex, 0);
    assert.deepEqual(out[0].regionTransfers, [{ toCode: "POL" }]);
    assert.deepEqual(out[0].polityChanges, []);
    assert.deepEqual(out[0].ledgerChanges, []);
    assert.deepEqual(out[0].unitOps, []);
    assert.deepEqual(out[0].createdChats, []);
  });

  it("accepts a bare array as well as an {impacts:[]} wrapper", () => {
    const out = normalizeImpactsPayload([{ eventIndex: 2 }], 0, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].eventIndex, 2);
  });

  it("treats an empty batch reply as valid (no impacts)", () => {
    assert.deepEqual(normalizeImpactsPayload({ impacts: [] }, 0, 10), []);
    assert.deepEqual(normalizeImpactsPayload({}, 0, 10), []);
    assert.deepEqual(normalizeImpactsPayload("garbage", 0, 10), []);
  });

  it("drops out-of-range eventIndex against the batch window", () => {
    const out = normalizeImpactsPayload(
      { impacts: [{ eventIndex: 10 }, { eventIndex: 14 }, { eventIndex: 19 }, { eventIndex: 25 }] },
      10,
      10, // window [10, 20)
    );
    assert.deepEqual(out.map((e) => e.eventIndex), [10, 14, 19]);
  });

  it("drops duplicate eventIndex, keeping the first", () => {
    const out = normalizeImpactsPayload(
      { impacts: [
        { eventIndex: 3, regionTransfers: [{ toCode: "FIRST" }] },
        { eventIndex: 3, regionTransfers: [{ toCode: "SECOND" }] },
      ] },
      0,
      10,
    );
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].regionTransfers, [{ toCode: "FIRST" }]);
  });

  it("coerces junk (missing/NaN index, non-object entries)", () => {
    const out = normalizeImpactsPayload(
      { impacts: [null, 5, "x", { noIndex: true }, { eventIndex: "2" }, { eventIndex: 1.9 }] },
      0,
      10,
    );
    // "2" -> 2, 1.9 -> 1 (truncated); the rest are dropped
    assert.deepEqual(out.map((e) => e.eventIndex).sort((a, b) => a - b), [1, 2]);
  });
});

describe("mergeImpactsByIndex", () => {
  it("merges batch impacts back onto events by global index across offsets", () => {
    const events = makeEvents(15);
    // Batch 0 covered indices 0-9, batch 1 covered 10-14.
    const batch0 = normalizeImpactsPayload({ impacts: [{ eventIndex: 2, ledgerChanges: [{ code: "A" }] }] }, 0, 10);
    const batch1 = normalizeImpactsPayload({ impacts: [{ eventIndex: 12, regionTransfers: [{ toCode: "B" }] }] }, 10, 5);
    const merged = mergeImpactsByIndex(events, [...batch0, ...batch1]);

    assert.equal(merged.length, 15);
    assert.deepEqual(merged[2].impacts.ledgerChanges, [{ code: "A" }]);
    assert.deepEqual(merged[12].impacts.regionTransfers, [{ toCode: "B" }]);
    // An unmentioned event still gets a full empty impacts object.
    assert.deepEqual(merged[5].impacts, {
      regionTransfers: [],
      polityChanges: [],
      ledgerChanges: [],
      unitOps: [],
      createdChats: [],
    });
    // Original event fields are preserved.
    assert.equal(merged[12].title, "Event 12");
  });

  it("ignores impact entries whose index falls outside the event list", () => {
    const events = makeEvents(3);
    const merged = mergeImpactsByIndex(events, [
      { eventIndex: 0, regionTransfers: [{ toCode: "X" }] },
      { eventIndex: 99, regionTransfers: [{ toCode: "OUT" }] },
    ]);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged[0].impacts.regionTransfers, [{ toCode: "X" }]);
    assert.deepEqual(merged[2].impacts.regionTransfers, []);
  });

  it("handles no impact entries at all (every event gets empty impacts)", () => {
    const merged = mergeImpactsByIndex(makeEvents(3), []);
    assert.equal(merged.length, 3);
    for (const event of merged) {
      assert.deepEqual(event.impacts.regionTransfers, []);
    }
  });
});
