import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExpansion } from "./expansion.js";

// A small synthetic map:  R1 - R2 - R3 - R4  with a branch  R2 - R5
const ADJ = {
  R1: ["R2"],
  R2: ["R1", "R3", "R5"],
  R3: ["R2", "R4"],
  R4: ["R3"],
  R5: ["R2"],
};

let seq = 0;
const U = (type, code, region, strength = 100) => ({
  id: `u${(seq += 1)}`,
  type,
  ownerCode: code,
  regionId: region,
  strength,
  lng: 0,
  lat: 0,
});

test("a settler founds an adjacent neutral region and is consumed", () => {
  const settler = U("settler", "A", "R2", 40);
  const r = resolveExpansion({ ownership: { R1: "A" }, units: [settler], adjacency: ADJ });
  assert.equal(r.ownership.R2, "A");
  assert.deepEqual(r.ownershipChanges, [{ regionId: "R2", from: "", to: "A", kind: "settle" }]);
  assert.deepEqual(r.removedUnitIds, [settler.id]);
  assert.equal(r.units.length, 0);
});

test("a settler cannot found a region that does not border owned land", () => {
  const settler = U("settler", "A", "R3", 40); // R3 borders R2/R4; A owns only R1
  const r = resolveExpansion({ ownership: { R1: "A" }, units: [settler], adjacency: ADJ });
  assert.equal(r.ownership.R3, undefined);
  assert.equal(r.ownershipChanges.length, 0);
  assert.equal(r.units.length, 1); // settler survives, waiting
});

test("an enemy army contests neutral land: no claim and the settler is lost", () => {
  const settler = U("settler", "A", "R2", 40);
  const raider = U("infantry", "B", "R2", 100);
  const r = resolveExpansion({ ownership: { R1: "A" }, units: [settler, raider], adjacency: ADJ });
  assert.equal(r.ownership.R2, undefined);
  assert.equal(r.ownershipChanges.length, 0);
  assert.deepEqual(r.removedUnitIds, [settler.id]);
  assert.ok(r.units.some((u) => u.id === raider.id)); // raider remains
});

test("two powers' settlers compete for the same region: standoff, both survive", () => {
  const sA = U("settler", "A", "R2", 40);
  const sB = U("settler", "B", "R2", 40); // R2 borders R1(A) and R5(B)
  const r = resolveExpansion({ ownership: { R1: "A", R5: "B" }, units: [sA, sB], adjacency: ADJ });
  assert.equal(r.ownership.R2, undefined);
  assert.equal(r.ownershipChanges.length, 0);
  assert.equal(r.removedUnitIds.length, 0);
  assert.equal(r.units.length, 2);
});

test("an undefended enemy region adjacent to the attacker is conquered", () => {
  const army = U("infantry", "A", "R5", 100); // R5 owned by B, undefended; borders R2(A)
  const r = resolveExpansion({ ownership: { R1: "A", R2: "A", R5: "B" }, units: [army], adjacency: ADJ });
  assert.equal(r.ownership.R5, "A");
  assert.deepEqual(r.ownershipChanges, [{ regionId: "R5", from: "B", to: "A", kind: "conquest" }]);
});

test("a defended enemy region does not fall", () => {
  const attacker = U("infantry", "A", "R5", 100);
  const defender = U("garrison", "B", "R5", 80);
  const r = resolveExpansion({
    ownership: { R1: "A", R2: "A", R5: "B" },
    units: [attacker, defender],
    adjacency: ADJ,
  });
  assert.equal(r.ownership.R5, "B");
  assert.equal(r.ownershipChanges.length, 0);
});

test("conquest is adjacency-gated: a non-bordering army cannot claim enemy land", () => {
  const army = U("infantry", "A", "R4", 100); // R4 owned by B; A borders nothing next to R4
  const r = resolveExpansion({ ownership: { R4: "B" }, units: [army], adjacency: ADJ });
  assert.equal(r.ownership.R4, "B");
  assert.equal(r.ownershipChanges.length, 0);
});

test("a power may escort its own settler with its own army and still found", () => {
  const settler = U("settler", "A", "R2", 40);
  const escort = U("infantry", "A", "R2", 100);
  const r = resolveExpansion({ ownership: { R1: "A" }, units: [settler, escort], adjacency: ADJ });
  assert.equal(r.ownership.R2, "A");
  assert.deepEqual(r.ownershipChanges, [{ regionId: "R2", from: "", to: "A", kind: "settle" }]);
  assert.deepEqual(r.removedUnitIds, [settler.id]);
  assert.ok(r.units.some((u) => u.id === escort.id)); // escort remains
});

test("occupancy falls back to regionAt when a unit has no regionId", () => {
  const settler = { id: "s1", type: "settler", ownerCode: "A", strength: 40, lng: 1, lat: 1 };
  const regionAt = (lng, lat) => (lng === 1 && lat === 1 ? "R2" : null);
  const r = resolveExpansion({ ownership: { R1: "A" }, units: [settler], adjacency: ADJ, regionAt });
  assert.equal(r.ownership.R2, "A");
  assert.deepEqual(r.ownershipChanges, [{ regionId: "R2", from: "", to: "A", kind: "settle" }]);
});
