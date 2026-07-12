import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyEventImpactsToWorld,
  normalizeEventEntry,
  normalizeWorldState,
  summarizePolityLedger,
} from "./gameState.js";

// normalizeLedgerChange / normalizePolityChange / normalizePolityOverride are
// internal, so they are exercised through the public entry points that call
// them: normalizeEventEntry (impacts), normalizeWorldState (ledgers +
// overrides) and applyEventImpactsToWorld (the apply pipeline).
const ledgerChangesOf = (ledgerChanges) =>
  normalizeEventEntry({ title: "e", impacts: { ledgerChanges } }).impacts.ledgerChanges;

const polityChangesOf = (polityChanges) =>
  normalizeEventEntry({ title: "e", impacts: { polityChanges } }).impacts.polityChanges;

const applyLedgerChanges = (world, ledgerChanges, date = "1939-05-01") =>
  applyEventImpactsToWorld({
    world,
    events: [{ title: "e", date, impacts: { ledgerChanges } }],
  }).world;

const applyPolityChanges = (world, polityChanges, date = "1939-05-01") =>
  applyEventImpactsToWorld({
    world,
    events: [{ title: "e", date, impacts: { polityChanges } }],
  }).world;

describe("polity ledger normalization", () => {
  it("defaults an empty world to an empty ledger map", () => {
    assert.deepEqual(normalizeWorldState({}).polityLedgers, {});
  });

  it("normalizes a ledger: clamps stats, defaults missing to 50, coerces kinds", () => {
    const { polityLedgers } = normalizeWorldState({
      polityLedgers: {
        GER: {
          code: "GER",
          updatedDate: "1939-01-01",
          notes: "watch the east",
          stats: { economy: 71, stability: "nope", military: 150, technology: -20 },
          developments: [
            { name: "University", kind: "wonder", regionName: "Prussia", builtDate: "1900-01-01" },
            { name: "Autobahn", kind: "totally-made-up" },
          ],
        },
      },
    });

    const ger = polityLedgers.GER;
    assert.equal(ger.code, "GER");
    assert.equal(ger.notes, "watch the east");
    assert.equal(ger.updatedDate, "1939-01-01");
    // economy passes through; junk -> 50; over/under clamp to 100/0; missing -> 50.
    assert.deepEqual(ger.stats, {
      stability: 50,
      economy: 71,
      military: 100,
      technology: 0,
      prestige: 50,
    });
    assert.equal(ger.developments.length, 2);
    assert.equal(ger.developments[0].kind, "wonder");
    assert.equal(ger.developments[1].kind, "other"); // unknown kind -> other
    // every stored development carries a stable id.
    assert.ok(ger.developments.every((dev) => dev.id));
  });

  it("drops junk entries and developments, and re-keys by the ledger's own code", () => {
    const { polityLedgers } = normalizeWorldState({
      polityLedgers: {
        // stored under the wrong key — must land at .GER
        weird_key: { code: "GER", developments: [{ name: "Port" }, "junk", { kind: "building" }] },
        BAD: 42,
        "": { code: "" }, // no code from value AND no key fallback -> dropped
      },
    });

    assert.deepEqual(Object.keys(polityLedgers), ["GER"]);
    // only the one named development survives (bare string + nameless dropped).
    assert.equal(polityLedgers.GER.developments.length, 1);
    assert.equal(polityLedgers.GER.developments[0].name, "Port");
  });

  it("round-trips: re-normalizing a normalized world is stable", () => {
    const once = normalizeWorldState({
      polityLedgers: {
        GER: {
          code: "GER",
          stats: { economy: 60 },
          developments: [{ name: "Uni", kind: "building" }],
          notes: "n",
        },
      },
    });
    const twice = normalizeWorldState(once);
    assert.deepEqual(twice.polityLedgers, once.polityLedgers);
  });
});

describe("ledgerChange normalization", () => {
  it("keeps only finite non-zero deltas for the five known stats", () => {
    const [change] = ledgerChangesOf([
      { code: "GER", statChanges: { economy: 5, stability: -3, military: 0, prestige: "x", galaxy: 9 } },
    ]);
    assert.deepEqual(change.statChanges, { economy: 5, stability: -3 });
  });

  it("normalizes addDevelopments (name required) and removeDevelopments (non-empty strings)", () => {
    const [change] = ledgerChangesOf([
      {
        code: "GER",
        addDevelopments: [{ name: "Uni", kind: "building" }, { kind: "building" }, "junk"],
        removeDevelopments: ["Old Fort", "", 7, "   "],
      },
    ]);
    assert.equal(change.addDevelopments.length, 1);
    assert.equal(change.addDevelopments[0].name, "Uni");
    // 7 coerces to "7"; blanks drop.
    assert.deepEqual(change.removeDevelopments, ["Old Fort", "7"]);
  });

  it("returns null when there is no code", () => {
    assert.deepEqual(ledgerChangesOf([{ statChanges: { economy: 5 } }]), []);
  });

  it("returns null when nothing is effectively changed (incl. unknown stats only)", () => {
    assert.deepEqual(ledgerChangesOf([{ code: "GER" }]), []);
    assert.deepEqual(ledgerChangesOf([{ code: "GER", statChanges: { galaxy: 9, economy: 0 } }]), []);
    assert.deepEqual(ledgerChangesOf([{ code: "GER", removeDevelopments: [""] }]), []);
  });
});

describe("applying ledgerChanges to the world", () => {
  it("creates a ledger lazily with all stats at 50 and stamps updatedDate", () => {
    const world = applyLedgerChanges({}, [{ code: "GER", statChanges: { economy: 5 } }], "1939-06-06");
    const ger = world.polityLedgers.GER;
    assert.ok(ger);
    assert.equal(ger.updatedDate, "1939-06-06");
    assert.deepEqual(ger.stats, {
      stability: 50,
      economy: 55,
      military: 50,
      technology: 50,
      prestige: 50,
    });
  });

  it("clamps stat deltas at both ends", () => {
    const seed = {
      polityLedgers: { GER: { code: "GER", stats: { economy: 98, stability: 3 } } },
    };
    const world = applyLedgerChanges(seed, [
      { code: "GER", statChanges: { economy: 10, stability: -10 } },
    ]);
    assert.equal(world.polityLedgers.GER.stats.economy, 100);
    assert.equal(world.polityLedgers.GER.stats.stability, 0);
  });

  it("appends developments, assigning id and defaulting builtDate to the event date", () => {
    const world = applyLedgerChanges({}, [
      {
        code: "GER",
        addDevelopments: [
          { name: "Autobahn", kind: "infrastructure" },
          { name: "Cathedral", kind: "wonder", builtDate: "1400-01-01" },
        ],
      },
    ], "1939-05-01");
    const devs = world.polityLedgers.GER.developments;
    assert.equal(devs.length, 2);
    assert.ok(devs[0].id);
    assert.equal(devs[0].builtDate, "1939-05-01"); // defaulted to event date
    assert.equal(devs[1].builtDate, "1400-01-01"); // explicit date preserved
  });

  it("removes developments by id and by case-insensitive name", () => {
    const seed = {
      polityLedgers: {
        GER: {
          code: "GER",
          developments: [
            { id: "dev-keep", name: "Keep" },
            { id: "dev-byid", name: "By Id" },
            { id: "dev-byname", name: "University of Königsberg" },
          ],
        },
      },
    };
    const world = applyLedgerChanges(seed, [
      { code: "GER", removeDevelopments: ["dev-byid", "university of königsberg"] },
    ]);
    assert.deepEqual(
      world.polityLedgers.GER.developments.map((dev) => dev.id),
      ["dev-keep"],
    );
  });

  it("replaces notes and bumps updatedDate", () => {
    const seed = {
      polityLedgers: { GER: { code: "GER", notes: "old", updatedDate: "1900-01-01" } },
    };
    const world = applyLedgerChanges(seed, [{ code: "GER", notes: "new plan" }], "1939-09-01");
    assert.equal(world.polityLedgers.GER.notes, "new plan");
    assert.equal(world.polityLedgers.GER.updatedDate, "1939-09-01");
  });
});

describe("polity lifecycle (status + absorbedBy)", () => {
  it("stored overrides default to active with empty absorbedBy; junk status -> active", () => {
    const { polityOverrides } = normalizeWorldState({
      polityOverrides: {
        FRA: { code: "FRA" },
        BUL: { code: "BUL", status: "annexed", absorbedBy: "BYZ" },
        JNK: { code: "JNK", status: "imaginary" },
      },
    });
    assert.equal(polityOverrides.FRA.status, "active");
    assert.equal(polityOverrides.FRA.absorbedBy, "");
    assert.equal(polityOverrides.BUL.status, "annexed");
    assert.equal(polityOverrides.BUL.absorbedBy, "BYZ");
    assert.equal(polityOverrides.JNK.status, "active"); // junk -> active
  });

  it("polityChanges pass a valid status through; junk/omitted status becomes '' (no change)", () => {
    const [annexed] = polityChangesOf([{ code: "BUL", status: "annexed", absorbedBy: "BYZ" }]);
    assert.equal(annexed.status, "annexed");
    assert.equal(annexed.absorbedBy, "BYZ");

    const [renamed] = polityChangesOf([{ code: "BUL", name: "New Bulgaria", status: "imaginary" }]);
    assert.equal(renamed.status, ""); // junk -> no change
  });

  it("applies status/absorbedBy onto the override, and '' status leaves it untouched", () => {
    const annexedWorld = applyPolityChanges({}, [
      { code: "BUL", status: "annexed", absorbedBy: "BYZ" },
    ]);
    assert.equal(annexedWorld.polityOverrides.BUL.status, "annexed");
    assert.equal(annexedWorld.polityOverrides.BUL.absorbedBy, "BYZ");

    // A later change with no status must not resurrect the polity.
    const thenRenamed = applyPolityChanges(annexedWorld, [{ code: "BUL", name: "Occupied Bulgaria" }]);
    assert.equal(thenRenamed.polityOverrides.BUL.status, "annexed");
    assert.equal(thenRenamed.polityOverrides.BUL.name, "Occupied Bulgaria");
  });
});

describe("summarizePolityLedger", () => {
  it("returns '' for a null or empty ledger", () => {
    assert.equal(summarizePolityLedger(null), "");
    assert.equal(summarizePolityLedger({}), "");
    assert.equal(summarizePolityLedger(undefined), "");
  });

  it("renders the stat line, development lines and notes", () => {
    const text = summarizePolityLedger({
      code: "GER",
      stats: { stability: 62, economy: 71, military: 55, technology: 48, prestige: 60 },
      developments: [
        { name: "University", kind: "building", builtDate: "1939-05-01", note: "top physics" },
        { name: "Autobahn", kind: "infrastructure" },
      ],
      notes: "guard the east",
    });

    const lines = text.split("\n");
    assert.equal(lines[0], "stability 62 · economy 71 · military 55 · technology 48 · prestige 60");
    assert.equal(lines[1], "- University (building, built 1939-05-01) — top physics");
    assert.equal(lines[2], "- Autobahn (infrastructure)");
    assert.equal(lines[3], "Notes: guard the east");
  });

  it("caps the development list and reports the overflow", () => {
    const developments = Array.from({ length: 35 }, (_, i) => ({
      name: `Dev ${i}`,
      kind: "building",
    }));
    const text = summarizePolityLedger({ code: "GER", developments });
    const lines = text.split("\n");
    // 1 stat line + 30 development lines + 1 overflow line.
    assert.equal(lines.length, 32);
    assert.equal(lines[31], "…and 5 more");

    const capped = summarizePolityLedger({ code: "GER", developments }, { maxDevelopments: 2 });
    const cappedLines = capped.split("\n");
    assert.equal(cappedLines.length, 4); // stats + 2 devs + overflow
    assert.equal(cappedLines[3], "…and 33 more");
  });
});
