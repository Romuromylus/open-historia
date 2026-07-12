import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRegionMenu,
  chunkEvents,
  detectPolityCodes,
  expandAnnexation,
  holdingsForCode,
  mergeAdjudicationIntoEvents,
  mergeImpactsByIndex,
  nameTokens,
  normalizeImpactsPayload,
  regionOwnerCode,
  resolveAdjudication,
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
  it("strips regionTransfers and sanitizes polityChanges, defaulting every array", () => {
    const out = normalizeImpactsPayload(
      {
        impacts: [
          {
            eventIndex: 0,
            regionTransfers: [{ toCode: "POL" }],
            polityChanges: [{ code: "BUL", status: "annexed", absorbedBy: "BYZ", name: "Rump Bulgaria" }],
          },
        ],
      },
      0,
      10,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].eventIndex, 0);
    // Territory belongs to the adjudicator — the encoder's transfers are dropped.
    assert.deepEqual(out[0].regionTransfers, []);
    // A rename survives; status/absorbedBy are stripped so the encoder can't annex.
    assert.deepEqual(out[0].polityChanges, [{ code: "BUL", name: "Rump Bulgaria" }]);
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
        { eventIndex: 3, ledgerChanges: [{ code: "FIRST" }] },
        { eventIndex: 3, ledgerChanges: [{ code: "SECOND" }] },
      ] },
      0,
      10,
    );
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].ledgerChanges, [{ code: "FIRST" }]);
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
    const batch1 = normalizeImpactsPayload({ impacts: [{ eventIndex: 12, unitOps: [{ op: "remove", unitId: "u1" }] }] }, 10, 5);
    const merged = mergeImpactsByIndex(events, [...batch0, ...batch1]);

    assert.equal(merged.length, 15);
    assert.deepEqual(merged[2].impacts.ledgerChanges, [{ code: "A" }]);
    assert.deepEqual(merged[12].impacts.unitOps, [{ op: "remove", unitId: "u1" }]);
    // The encoder never moves borders — every event's regionTransfers stay empty.
    assert.deepEqual(merged[12].impacts.regionTransfers, []);
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

  it("carries hand-built entries through unchanged (generic merge, no stripping)", () => {
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
      maxPolities: 8,
    });
    assert.equal(codes.length, 8);
  });
});

describe("buildRegionMenu", () => {
  const nameByCode = new Map([["BYZ", "Byzantine Empire"], ["BGR", "Bulgaria"]]);

  it("lists holdings as globally-numbered keys and resolves keys + exact ids", () => {
    const { text, byKey } = buildRegionMenu({
      polityCodes: ["BYZ", "BGR"],
      regions: REGIONS,
      ownership: OWNERSHIP,
      nameByCode,
    });
    // BYZ contributes R1..R4 (catalog order), BGR contributes R5.
    assert.match(text, /R1: Aydın \[TUR\.8_1\] — held by Byzantine Empire \(BYZ\)/);
    assert.match(text, /R5: Plovdiv \[BGR\.5_1\] — held by Bulgaria \(BGR\)/);
    // Menu keys are case-insensitive and each region's exact id also resolves.
    assert.deepEqual(byKey.get("R1"), { regionId: "TUR.8_1", ownerCode: "BYZ" });
    assert.deepEqual(byKey.get("TUR.8_1".toUpperCase()), { regionId: "TUR.8_1", ownerCode: "BYZ" });
    assert.deepEqual(byKey.get("R5"), { regionId: "BGR.5_1", ownerCode: "BGR" });
  });

  it("caps regions per polity and reports the overflow count", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ id: `X${i}`, name: `Region ${i}`, countryCode: "BYZ" }));
    const { text, byKey } = buildRegionMenu({
      polityCodes: ["BYZ"],
      regions: many,
      ownership: {},
      nameByCode,
      regionCap: 50,
    });
    assert.match(text, /…and 5 more region\(s\) held by Byzantine Empire \(BYZ\) not listed here\./);
    // Only 50 numbered keys are emitted (plus their 50 exact-id aliases).
    const keyCount = [...byKey.keys()].filter((k) => /^R\d+$/.test(k)).length;
    assert.equal(keyCount, 50);
  });

  it("notes a polity that holds no regions", () => {
    const { text } = buildRegionMenu({
      polityCodes: ["SRB"],
      regions: REGIONS,
      ownership: OWNERSHIP,
      nameByCode: new Map([["SRB", "Serbia"]]),
    });
    assert.match(text, /Serbia \(SRB\) — holds no regions on the current map\./);
  });
});

describe("resolveAdjudication", () => {
  const { byKey } = buildRegionMenu({
    polityCodes: ["BYZ", "BGR"],
    regions: REGIONS,
    ownership: OWNERSHIP,
    nameByCode: new Map([["BYZ", "Byzantine Empire"], ["BGR", "Bulgaria"]]),
  });
  const validCodes = ["BYZ", "BGR", "SRB"];

  it("resolves menu keys (case-insensitive) and exact ids, filling fromCode from the owner", () => {
    const out = resolveAdjudication(
      { transfers: [
        { region: "r1", toCode: "bgr", eventIndex: 0 },
        { region: "TUR.20_1", toCode: "SRB", eventIndex: 2 },
      ] },
      { byKey, eventCount: 3, validCodes },
    );
    assert.deepEqual(out.transfers, [
      { eventIndex: 0, regionId: "TUR.8_1", fromCode: "BYZ", toCode: "BGR" },
      { eventIndex: 2, regionId: "TUR.20_1", fromCode: "BYZ", toCode: "SRB" },
    ]);
    assert.deepEqual(out.annexations, []);
  });

  it("drops unknown region keys and invalid target codes, counting them", () => {
    const out = resolveAdjudication(
      { transfers: [
        { region: "R99", toCode: "BGR", eventIndex: 0 },
        { region: "R1", toCode: "ZZZ", eventIndex: 0 },
      ] },
      { byKey, eventCount: 3, validCodes },
    );
    assert.deepEqual(out.transfers, []);
    assert.equal(out.dropped, 2);
  });

  it("re-attaches an out-of-range eventIndex to the LAST event", () => {
    const out = resolveAdjudication(
      { transfers: [{ region: "R1", toCode: "BGR", eventIndex: 99 }] },
      { byKey, eventCount: 3, validCodes },
    );
    assert.equal(out.transfers[0].eventIndex, 2); // clamped to last
  });

  it("dedupes repeated region ids (first pick wins)", () => {
    const out = resolveAdjudication(
      { transfers: [
        { region: "R1", toCode: "BGR", eventIndex: 0 },
        { region: "TUR.8_1", toCode: "SRB", eventIndex: 1 }, // same region as R1
      ] },
      { byKey, eventCount: 3, validCodes },
    );
    assert.equal(out.transfers.length, 1);
    assert.equal(out.transfers[0].toCode, "BGR");
    assert.equal(out.dropped, 1);
  });

  it("resolves and dedupes annexations, validating both codes", () => {
    const out = resolveAdjudication(
      { annexations: [
        { code: "bgr", absorbedBy: "byz", eventIndex: 1 },
        { code: "BGR", absorbedBy: "BYZ", eventIndex: 2 }, // duplicate loser
        { code: "SRB", absorbedBy: "ZZZ", eventIndex: 0 }, // invalid victor
      ] },
      { byKey, eventCount: 3, validCodes },
    );
    assert.deepEqual(out.annexations, [{ eventIndex: 1, code: "BGR", absorbedBy: "BYZ" }]);
    assert.equal(out.dropped, 2);
  });

  it("treats empty/absent arrays as a valid empty result", () => {
    assert.deepEqual(resolveAdjudication({}, { byKey, eventCount: 3, validCodes }), {
      transfers: [],
      annexations: [],
      dropped: 0,
    });
    assert.deepEqual(resolveAdjudication({ transfers: [], annexations: [] }, { byKey, eventCount: 3, validCodes }), {
      transfers: [],
      annexations: [],
      dropped: 0,
    });
  });
});

describe("expandAnnexation", () => {
  it("expands to every held region plus an annexed polity change", () => {
    const { transfers, polityChanges } = expandAnnexation("BYZ", {
      regions: REGIONS,
      ownership: OWNERSHIP,
      absorbedBy: "BGR",
    });
    assert.deepEqual(transfers.map((t) => t.regionId).sort(), ["GRC.1_1", "TUR.20_1", "TUR.33_1", "TUR.8_1"]);
    for (const transfer of transfers) {
      assert.equal(transfer.fromCode, "BYZ");
      assert.equal(transfer.toCode, "BGR");
      assert.ok(transfer.regionName); // catalog name attached
    }
    assert.deepEqual(polityChanges, [{ code: "BYZ", status: "annexed", absorbedBy: "BGR" }]);
  });

  it("still emits the polity change when the polity holds no regions", () => {
    const { transfers, polityChanges } = expandAnnexation("SRB", {
      regions: REGIONS,
      ownership: OWNERSHIP,
      absorbedBy: "BYZ",
    });
    assert.deepEqual(transfers, []);
    assert.deepEqual(polityChanges, [{ code: "SRB", status: "annexed", absorbedBy: "BYZ" }]);
  });
});

describe("mergeAdjudicationIntoEvents", () => {
  it("appends resolved transfers (with catalog names) and preserves existing impacts", () => {
    const events = mergeImpactsByIndex(makeEvents(3), [{ eventIndex: 0, ledgerChanges: [{ code: "A" }] }]);
    const merged = mergeAdjudicationIntoEvents(
      events,
      { transfers: [{ eventIndex: 0, regionId: "TUR.8_1", fromCode: "BYZ", toCode: "BGR" }], annexations: [] },
      { regions: REGIONS, ownership: OWNERSHIP },
    );
    assert.deepEqual(merged[0].impacts.regionTransfers, [
      { regionId: "TUR.8_1", regionName: "Aydın", fromCode: "BYZ", toCode: "BGR" },
    ]);
    // Stage-2 impacts on the same event survive.
    assert.deepEqual(merged[0].impacts.ledgerChanges, [{ code: "A" }]);
  });

  it("expands an annexation event into transfers plus the annexed polity change", () => {
    const events = mergeImpactsByIndex(makeEvents(3), []);
    const merged = mergeAdjudicationIntoEvents(
      events,
      { transfers: [], annexations: [{ eventIndex: 1, code: "BGR", absorbedBy: "BYZ" }] },
      { regions: REGIONS, ownership: OWNERSHIP },
    );
    assert.deepEqual(merged[1].impacts.regionTransfers, [
      { regionId: "BGR.5_1", regionName: "Plovdiv", fromCode: "BGR", toCode: "BYZ" },
    ]);
    assert.deepEqual(merged[1].impacts.polityChanges, [
      { code: "BGR", status: "annexed", absorbedBy: "BYZ" },
    ]);
    // Untouched events keep empty region transfers.
    assert.deepEqual(merged[0].impacts.regionTransfers, []);
  });

  it("ignores out-of-range indices and returns events unchanged when nothing resolves", () => {
    const events = mergeImpactsByIndex(makeEvents(2), []);
    const merged = mergeAdjudicationIntoEvents(
      events,
      { transfers: [{ eventIndex: 99, regionId: "TUR.8_1", toCode: "BGR" }], annexations: [] },
      { regions: REGIONS, ownership: OWNERSHIP },
    );
    assert.deepEqual(merged[0].impacts.regionTransfers, []);
    assert.deepEqual(merged[1].impacts.regionTransfers, []);
  });
});
