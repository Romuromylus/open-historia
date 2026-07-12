import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRegionVocabularyBlock,
  buildRepairCandidates,
  chunkEvents,
  detectPolityCodes,
  formatPolityRegionVocabulary,
  holdingsForCode,
  mergeImpactsByIndex,
  mergeRepairedTransfers,
  nameTokens,
  normalizeImpactsPayload,
  regionOwnerCode,
  selectBatchPolities,
  sharesNameToken,
  validateNarrativePayload,
} from "./turnPipeline.js";

// A small stand-in region catalog: Byzantine-held Aegean regions (owned via
// override), one Bulgaria region held via the stock countryCode, and a decoy
// that shares a token with an archaic name.
const REGIONS = [
  { id: "TUR.8_1", name: "Aydın", country: "Turkey", countryCode: "TUR" },
  { id: "TUR.20_1", name: "Denizli", country: "Turkey", countryCode: "TUR" },
  { id: "TUR.33_1", name: "Manisa", country: "Turkey", countryCode: "TUR" },
  { id: "GRC.1_1", name: "Philadelphia Plain", country: "Greece", countryCode: "GRC" },
  { id: "BGR.5_1", name: "Plovdiv", country: "Bulgaria", countryCode: "BGR" },
];
// Byzantines (BYZ) hold the three Anatolian regions + the Greek plain via
// override; Plovdiv is Bulgaria's by its stock countryCode.
const OWNERSHIP = { "TUR.8_1": "BYZ", "TUR.20_1": "BYZ", "TUR.33_1": "BYZ", "GRC.1_1": "BYZ" };
const POLITIES = [
  { code: "BYZ", name: "Byzantine Empire", aliases: ["Rhomania", "the Romans"] },
  { code: "BGR", name: "Bulgaria", aliases: [] },
  { code: "SRB", name: "Serbia", aliases: [] },
];

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

describe("regionOwnerCode / holdingsForCode", () => {
  it("reads the live override first, then the stock countryCode", () => {
    assert.equal(regionOwnerCode(REGIONS[0], OWNERSHIP), "BYZ"); // overridden
    assert.equal(regionOwnerCode(REGIONS[4], OWNERSHIP), "BGR"); // stock code
    assert.equal(regionOwnerCode({ id: "X" }, {}), ""); // nothing known
  });

  it("lists every region a polity currently holds (override or stock)", () => {
    const byz = holdingsForCode(REGIONS, OWNERSHIP, "byz").map((r) => r.id);
    assert.deepEqual(byz.sort(), ["GRC.1_1", "TUR.20_1", "TUR.33_1", "TUR.8_1"]);
    assert.deepEqual(holdingsForCode(REGIONS, OWNERSHIP, "BGR").map((r) => r.id), ["BGR.5_1"]);
    assert.deepEqual(holdingsForCode(REGIONS, OWNERSHIP, ""), []);
  });
});

describe("nameTokens / sharesNameToken", () => {
  it("keeps only whole-word tokens of the minimum length", () => {
    assert.deepEqual([...nameTokens("Philadelphia Plain")].sort(), ["philadelphia", "plain"]);
    assert.equal(nameTokens("Aydın").has("aydın"), true);
    assert.equal(nameTokens("of the by").size, 0); // all shorter than 4
  });

  it("bridges an archaic name to a catalog name via a shared token", () => {
    assert.equal(sharesNameToken("the Philadelphia theme", "Philadelphia Plain"), true);
    assert.equal(sharesNameToken("Denizli sanjak", "Denizli"), true);
    assert.equal(sharesNameToken("Manisa", "Aydın"), false);
  });
});

describe("detectPolityCodes", () => {
  it("matches display names, aliases, and whole-word codes", () => {
    assert.deepEqual(detectPolityCodes("The Byzantine Empire marched east", POLITIES), ["BYZ"]);
    assert.deepEqual(detectPolityCodes("Rhomania mustered its themes", POLITIES), ["BYZ"]);
    assert.deepEqual(detectPolityCodes("BGR sued for peace", POLITIES), ["BGR"]);
  });

  it("returns codes in catalog order, deduped, and ignores empty text", () => {
    assert.deepEqual(
      detectPolityCodes("Bulgaria and the Byzantine Empire and Bulgaria again", POLITIES),
      ["BYZ", "BGR"],
    );
    assert.deepEqual(detectPolityCodes("", POLITIES), []);
  });

  it("does not match a code buried inside a longer word", () => {
    // "SRB" must not fire on "disturbing"; no polity is mentioned here.
    assert.deepEqual(detectPolityCodes("a disturbing calm settled over the coast", POLITIES), []);
  });
});

describe("selectBatchPolities", () => {
  it("always includes the player, then every mentioned polity", () => {
    const codes = selectBatchPolities({
      batchText: "Bulgaria raided the frontier",
      polityEntries: POLITIES,
      playerCode: "BYZ",
    });
    assert.equal(codes[0], "BYZ"); // player first
    assert.ok(codes.includes("BGR"));
  });

  it("tops up from fallback codes when too few are detected", () => {
    const codes = selectBatchPolities({
      batchText: "a quiet season passed with no war",
      polityEntries: POLITIES,
      playerCode: "BYZ",
      fallbackCodes: ["BGR", "SRB"],
      minPolities: 2,
    });
    assert.ok(codes.length >= 2);
    assert.equal(codes[0], "BYZ");
  });

  it("caps the number of polities", () => {
    const codes = selectBatchPolities({
      batchText: "",
      polityEntries: POLITIES,
      playerCode: "BYZ",
      fallbackCodes: ["A", "B", "C", "D", "E", "F", "G", "H"],
      maxPolities: 6,
    });
    assert.equal(codes.length, 6);
  });
});

describe("formatPolityRegionVocabulary / buildRegionVocabularyBlock", () => {
  it("lists held regions with exact names and ids under a partial-transfer header", () => {
    const text = formatPolityRegionVocabulary({
      code: "BYZ",
      name: "Byzantine Empire",
      regions: holdingsForCode(REGIONS, OWNERSHIP, "BYZ"),
    });
    assert.match(text, /REGIONS HELD BY Byzantine Empire \(BYZ\)/);
    assert.match(text, /- Aydın \[TUR\.8_1\]/);
    assert.match(text, /MUST name regions from this list exactly/);
  });

  it("caps the list and reports the overflow count", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ id: `R${i}`, name: `Region ${i}` }));
    const text = formatPolityRegionVocabulary({ code: "BYZ", name: "Byz", regions: many, cap: 50 });
    assert.match(text, /…and 5 more/);
  });

  it("notes when a polity holds no attributed regions", () => {
    const text = formatPolityRegionVocabulary({ code: "SRB", name: "Serbia", regions: [] });
    assert.match(text, /no regions currently attributed/);
  });

  it("builds one section per polity code with names from nameByCode", () => {
    const block = buildRegionVocabularyBlock({
      polityCodes: ["BYZ", "BGR"],
      regions: REGIONS,
      ownership: OWNERSHIP,
      nameByCode: new Map([["BYZ", "Byzantine Empire"], ["BGR", "Bulgaria"]]),
    });
    assert.match(block, /REGIONS HELD BY Byzantine Empire \(BYZ\)/);
    assert.match(block, /REGIONS HELD BY Bulgaria \(BGR\)/);
    assert.match(block, /- Plovdiv \[BGR\.5_1\]/);
  });
});

describe("buildRepairCandidates", () => {
  it("offers the fromCode polity's holdings plus token-sharing catalog regions", () => {
    const candidates = buildRepairCandidates(
      { regionName: "the Philadelphia theme", fromCode: "BYZ", toCode: "BGR" },
      { regions: REGIONS, ownership: OWNERSHIP },
    );
    const ids = candidates.map((c) => c.id);
    // All BYZ holdings appear, and the token match ("Philadelphia") is present.
    assert.ok(ids.includes("TUR.8_1"));
    assert.ok(ids.includes("GRC.1_1"));
  });

  it("dedupes by id and still works with no fromCode (token match only)", () => {
    const candidates = buildRepairCandidates(
      { regionName: "Denizli district", toCode: "BGR" },
      { regions: REGIONS, ownership: OWNERSHIP },
    );
    const ids = candidates.map((c) => c.id);
    assert.deepEqual(ids, ["TUR.20_1"]); // only the token match, once
  });

  it("returns nothing for an entry with no name and no fromCode", () => {
    assert.deepEqual(buildRepairCandidates({ toCode: "BGR" }, { regions: REGIONS }), []);
  });
});

describe("mergeRepairedTransfers", () => {
  it("keeps resolved originals and swaps in repairs per event index", () => {
    const original = [
      { eventIndex: 0, regionTransfers: [{ regionName: "Aydın", toCode: "BGR" }, { regionName: "Nowhere", toCode: "BGR" }] },
      { eventIndex: 1, regionTransfers: [{ regionName: "Somewhere", toCode: "SRB" }] },
    ];
    const resolvedByIndex = new Map([[0, [{ regionName: "Aydın", toCode: "BGR" }]]]); // event 0 kept one original
    const repairEntries = [
      { eventIndex: 0, regionTransfers: [{ regionId: "TUR.20_1", toCode: "BGR" }] },
    ];
    const merged = mergeRepairedTransfers(original, resolvedByIndex, repairEntries);
    // Event 0: kept original + repair; the unresolved "Nowhere" is dropped.
    assert.deepEqual(merged[0].regionTransfers, [
      { regionName: "Aydın", toCode: "BGR" },
      { regionId: "TUR.20_1", toCode: "BGR" },
    ]);
    // Event 1 was not in the repair reply — untouched.
    assert.deepEqual(merged[1].regionTransfers, [{ regionName: "Somewhere", toCode: "SRB" }]);
  });

  it("replaces all transfers when an event had no resolved originals", () => {
    const original = [{ eventIndex: 4, regionTransfers: [{ regionName: "Ghost", toCode: "BGR" }] }];
    const repairEntries = [{ eventIndex: 4, regionTransfers: [{ regionId: "TUR.8_1", toCode: "BGR" }] }];
    const merged = mergeRepairedTransfers(original, new Map(), repairEntries);
    assert.deepEqual(merged[4 - 4].regionTransfers, [{ regionId: "TUR.8_1", toCode: "BGR" }]);
  });

  it("accepts an object map or array for resolvedByIndex and leaves unmatched events alone", () => {
    const original = [{ eventIndex: 2, regionTransfers: [{ regionName: "X", toCode: "BGR" }] }];
    const merged = mergeRepairedTransfers(original, { 2: [] }, []); // empty repair reply
    assert.deepEqual(merged[0].regionTransfers, [{ regionName: "X", toCode: "BGR" }]);
  });
});
