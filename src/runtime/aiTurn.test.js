import { test } from "node:test";
import assert from "node:assert/strict";
import { planAiTurn } from "./aiTurn.js";
import { resolveExpansion } from "./expansion.js";

// Chain map:  R1 - R2 - R3 - R4 - R5, branch R2 - R6.  Centroids are arbitrary.
const ADJ = {
  R1: ["R2"],
  R2: ["R1", "R3", "R6"],
  R3: ["R2", "R4"],
  R4: ["R3", "R5"],
  R5: ["R4"],
  R6: ["R2"],
};
const CENT = { R1: [0, 0], R2: [1, 0], R3: [2, 0], R4: [3, 0], R5: [4, 0], R6: [1, 1] };

let seq = 0;
const U = (type, code, region, strength = 100) => ({
  id: `u${(seq += 1)}`,
  type,
  ownerCode: code,
  regionId: region,
  strength,
  lng: 0,
  lat: 0,
  status: "idle",
});

test("an idle settler on the home region is marched onto a claimable border region", () => {
  const settler = U("settler", "A", "R1", 10);
  const { units, orders } = planAiTurn({
    ownership: { R1: "A" },
    units: [settler],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { A: { aggression: 0.2, expansion: 0.9, caution: 0.3 } },
    playerCode: "Z",
    round: 1,
  });
  const moved = units.find((u) => u.id === settler.id);
  assert.equal(moved.regionId, "R2"); // R2 is A's only neutral frontier
  assert.equal(moved.status, "moving");
  assert.ok(orders.some((o) => o.kind === "settle-march" && o.to === "R2"));
});

test("planAiTurn then resolveExpansion: the AI settles a bordering neutral region in one turn", () => {
  const settler = U("settler", "A", "R1", 10);
  const planned = planAiTurn({
    ownership: { R1: "A" },
    units: [settler],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { A: { aggression: 0.2, expansion: 0.9, caution: 0.3 } },
    playerCode: "Z",
    round: 1,
  });
  const resolved = resolveExpansion({ ownership: { R1: "A" }, units: planned.units, adjacency: ADJ });
  assert.equal(resolved.ownership.R2, "A");
  assert.ok(resolved.ownershipChanges.some((c) => c.regionId === "R2" && c.kind === "settle"));
});

test("the player's own power is never given orders", () => {
  const settler = U("settler", "P", "R1", 10);
  const { units, orders } = planAiTurn({
    ownership: { R1: "P" },
    units: [settler],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { P: { aggression: 0.9, expansion: 0.9, caution: 0.1 } },
    playerCode: "P",
    round: 1,
  });
  assert.equal(units.length, 1); // no production
  assert.equal(units[0].regionId, "R1"); // no movement
  assert.equal(orders.length, 0);
});

test("an aggressive power commits armies against a bordering enemy region", () => {
  const a1 = U("infantry", "A", "R2", 100);
  const a2 = U("infantry", "A", "R2", 90);
  const { units, orders } = planAiTurn({
    ownership: { R1: "A", R2: "A", R3: "B" }, // R3 (enemy) borders R2 (A)
    units: [a1, a2],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { A: { aggression: 1.0, expansion: 0.2, caution: 0.1 } },
    playerCode: "Z",
    round: 5, // not a production turn for infantry period 1? period=1 so it may raise; that's fine
  });
  const assaults = orders.filter((o) => o.kind === "assault" && o.to === "R3");
  assert.ok(assaults.length >= 1, "at least one army should march on R3");
  assert.ok(units.some((u) => u.regionId === "R3" && u.ownerCode === "A"));
});

test("a peaceful power with an enemy on its border does not commit its whole army", () => {
  const a1 = U("infantry", "A", "R2", 100);
  const a2 = U("infantry", "A", "R2", 90);
  const { orders } = planAiTurn({
    ownership: { R1: "A", R2: "A", R3: "B" },
    units: [a1, a2],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { A: { aggression: 0.2, expansion: 0.5, caution: 0.9 } },
    playerCode: "Z",
    round: 5,
  });
  const assaults = orders.filter((o) => o.kind === "assault");
  assert.ok(assaults.length === 0, "a cautious, unaggressive power should hold its army");
});

test("production is deterministic and cadence-gated by temperament", () => {
  const base = {
    ownership: { R1: "A" },
    units: [U("garrison", "A", "R1", 120)],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { A: { aggression: 0.9, expansion: 0.9, caution: 0.1 } },
    playerCode: "Z",
  };
  const r1a = planAiTurn({ ...base, units: [{ ...base.units[0] }], round: 1 });
  const r1b = planAiTurn({ ...base, units: [{ ...base.units[0] }], round: 1 });
  // Same inputs → identical raise orders (deterministic).
  assert.deepEqual(
    r1a.orders.filter((o) => o.kind === "raise").map((o) => o.unitType).sort(),
    r1b.orders.filter((o) => o.kind === "raise").map((o) => o.unitType).sort(),
  );
  // An expansion-eager power with empty neutral land around it raises a settler on a period-1 turn.
  assert.ok(r1a.orders.some((o) => o.kind === "raise" && o.unitType === "settler"));
});

test("an eliminated power (no land) is skipped", () => {
  const orphan = U("infantry", "A", "R9", 100); // A owns nothing
  const { units, orders } = planAiTurn({
    ownership: { R1: "B" },
    units: [orphan],
    adjacency: ADJ,
    centroids: CENT,
    behaviors: { A: { aggression: 0.9 }, B: { expansion: 0.1 } },
    playerCode: "Z",
    round: 1,
  });
  assert.ok(!orders.some((o) => o.code === "A"));
  assert.equal(units.find((u) => u.id === orphan.id).regionId, "R9"); // untouched
});
