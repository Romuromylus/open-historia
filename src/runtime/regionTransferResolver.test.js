import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRegionTransfers } from "./regionTransferResolver.js";

// A miniature stock-map catalog: two Polish voivodeships, one German Land, and
// a name collision ("Podlaskie" exists in both Poland and a fictional PDX) to
// exercise disambiguation.
const REGIONS = [
  { country: "Poland", countryCode: "POL", id: "POL.7_1", name: "Mazowieckie" },
  { country: "Poland", countryCode: "POL", id: "POL.12_1", name: "Podlaskie" },
  { country: "Paradonia", countryCode: "PDX", id: "PDX.2_1", name: "Podlaskie" },
  { country: "Germany", countryCode: "DEU", id: "DEU.2_1", name: "Bayern" },
];

const POLITIES = {
  SOV: { aliases: ["USSR", "Soviet Russia"], code: "SOV", name: "Soviet Union" },
};

describe("resolveRegionTransfers", () => {
  it("passes an exact region id through, canonicalizing case drift", () => {
    const { transfers, unresolved } = resolveRegionTransfers(
      [{ regionId: "pol.7_1", toCode: "DEU" }],
      { regions: REGIONS },
    );
    assert.equal(unresolved.length, 0);
    assert.deepEqual(transfers.map((t) => t.regionId), ["POL.7_1"]);
    assert.equal(transfers[0].toCode, "DEU");
  });

  it("resolves a region NAME written into the regionId field", () => {
    const { transfers } = resolveRegionTransfers(
      [{ regionId: "Mazowieckie", toCode: "DEU" }],
      { regions: REGIONS },
    );
    assert.deepEqual(transfers.map((t) => t.regionId), ["POL.7_1"]);
  });

  it("resolves regionName when regionId is empty", () => {
    const { transfers } = resolveRegionTransfers(
      [{ regionId: "", regionName: "Bayern", toCode: "FRA" }],
      { regions: REGIONS },
    );
    assert.deepEqual(transfers.map((t) => t.regionId), ["DEU.2_1"]);
  });

  it("disambiguates duplicate names by the current owner (fromCode)", () => {
    const { transfers } = resolveRegionTransfers(
      [{ fromCode: "PDX", regionName: "Podlaskie", toCode: "SOV" }],
      { regions: REGIONS },
    );
    assert.deepEqual(transfers.map((t) => t.regionId), ["PDX.2_1"]);
  });

  it("disambiguates duplicate names by live ownership overrides", () => {
    const { transfers } = resolveRegionTransfers(
      [{ fromCode: "SOV", regionName: "Podlaskie", toCode: "DEU" }],
      { ownership: { "POL.12_1": "SOV" }, regions: REGIONS },
    );
    assert.deepEqual(transfers.map((t) => t.regionId), ["POL.12_1"]);
  });

  it("expands a whole-country name to everything that polity currently holds", () => {
    const { transfers } = resolveRegionTransfers(
      [{ regionName: "Poland", toCode: "DEU" }],
      { regions: REGIONS },
    );
    assert.deepEqual(
      transfers.map((t) => t.regionId).sort(),
      ["POL.12_1", "POL.7_1"],
    );
    assert.ok(transfers.every((t) => t.toCode === "DEU"));
  });

  it("whole-country expansion respects live overrides (lost land does not move twice)", () => {
    const { transfers } = resolveRegionTransfers(
      [{ regionName: "Poland", toCode: "SOV" }],
      { ownership: { "POL.7_1": "DEU" }, regions: REGIONS },
    );
    // Mazowieckie is already German, so only Podlaskie still moves with "Poland".
    assert.deepEqual(transfers.map((t) => t.regionId), ["POL.12_1"]);
  });

  it("resolves polity display names and aliases to scenario codes", () => {
    const { transfers } = resolveRegionTransfers(
      [{ regionId: "POL.7_1", toCode: "Soviet Union" }],
      { polityOverrides: POLITIES, regions: REGIONS },
    );
    assert.equal(transfers[0].toCode, "SOV");
  });

  it("expands a polity ALIAS used as the territory being transferred", () => {
    const { transfers } = resolveRegionTransfers(
      [{ regionName: "USSR", toCode: "DEU" }],
      { ownership: { "POL.12_1": "SOV" }, polityOverrides: POLITIES, regions: REGIONS },
    );
    assert.deepEqual(transfers.map((t) => t.regionId), ["POL.12_1"]);
  });

  it("drops transfers to the current owner (no-op moves)", () => {
    const { transfers, unresolved } = resolveRegionTransfers(
      [{ regionId: "POL.7_1", toCode: "POL" }],
      { regions: REGIONS },
    );
    assert.equal(transfers.length, 0);
    assert.equal(unresolved.length, 0);
  });

  it("reports unresolvable transfers instead of persisting dead overrides", () => {
    const { transfers, unresolved } = resolveRegionTransfers(
      [{ regionId: "Atlantis", toCode: "DEU" }, { regionName: "", toCode: "" }],
      { regions: REGIONS },
    );
    assert.equal(transfers.length, 0);
    assert.equal(unresolved.length, 2);
  });

  it("dedupes when several entries resolve to the same region", () => {
    const { transfers } = resolveRegionTransfers(
      [
        { regionId: "POL.7_1", toCode: "DEU" },
        { regionName: "Mazowieckie", toCode: "DEU" },
      ],
      { regions: REGIONS },
    );
    assert.equal(transfers.length, 1);
  });

  it("returns empty results for empty or malformed input", () => {
    assert.deepEqual(resolveRegionTransfers(null, { regions: REGIONS }).transfers, []);
    assert.deepEqual(resolveRegionTransfers([null, 42], { regions: REGIONS }).transfers, []);
  });
});
