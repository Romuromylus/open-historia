/*! Pax Colonia — deterministic expansion resolver.
 *
 * The engine owns territory truth; the LLM only narrates the changes this returns.
 * Given the current region ownership, the units on the map, and the region adjacency
 * graph, this computes every territory change for one turn under fixed rules:
 *
 *   SETTLE (neutral land): a power's SETTLER standing in an unowned region that BORDERS
 *     land it already holds founds a settlement there — the region becomes the power's
 *     and the settler is consumed. Blocked if any military unit contests the region
 *     (settlers caught in contested land are lost) or if two powers' settlers compete.
 *
 *   CONQUEST (enemy land): if a region's owner has no surviving military unit in it and
 *     an enemy with military units present BORDERS it, the region flips to that enemy
 *     (the strongest one). Defeating the defenders is the base game's seeded unit combat;
 *     this only finalizes who holds the ground.
 *
 * Adjacency-gated throughout, so empires only grow outward from what they already hold.
 * Pure and side-effect-free: no I/O, no globals, no clock — fully unit-testable.
 */

// Every unit type except "settler" is a military unit that can hold/contest ground.
const isSettler = (type) => type === "settler";

/**
 * @param {object}   args
 * @param {Record<string,string>} args.ownership  regionId -> ownerCode ("" / missing = neutral)
 * @param {Array<object>}         args.units      [{id,type,ownerCode,lng,lat,strength,regionId?}]
 * @param {Record<string,string[]>} args.adjacency regionId -> [neighborRegionId,...]
 * @param {(lng:number,lat:number)=>(string|null)} [args.regionAt] fallback occupancy lookup
 * @returns {{ownership:Record<string,string>, ownershipChanges:Array, units:Array, removedUnitIds:string[]}}
 */
export function resolveExpansion({ ownership, units, adjacency, regionAt }) {
  const owns = { ...ownership };
  const ownerOf = (rid) => owns[rid] || "";
  const neighborsOf = (rid) => adjacency[rid] || [];
  const bordersTerritoryOf = (rid, code) => neighborsOf(rid).some((n) => ownerOf(n) === code);

  // 1. Group units by the region they occupy.
  const occupancy = new Map(); // regionId -> units[]
  for (const u of units) {
    const rid = u.regionId || (regionAt ? regionAt(u.lng, u.lat) : null);
    if (!rid) continue;
    if (!occupancy.has(rid)) occupancy.set(rid, []);
    occupancy.get(rid).push(u);
  }

  const ownershipChanges = []; // {regionId, from, to, kind, ownerName?}
  const removedUnitIds = new Set();

  // 2. Resolve each occupied region independently (no cascading within one turn).
  for (const [rid, list] of occupancy) {
    const owner = ownerOf(rid);
    const militaryStrengthByCode = new Map(); // code -> summed strength
    const settlersByCode = new Map(); // code -> settler units[]
    for (const u of list) {
      const code = u.ownerCode;
      if (!code) continue;
      if (isSettler(u.type)) {
        if (!settlersByCode.has(code)) settlersByCode.set(code, []);
        settlersByCode.get(code).push(u);
      } else {
        militaryStrengthByCode.set(code, (militaryStrengthByCode.get(code) || 0) + (Number(u.strength) || 0));
      }
    }

    if (owner) {
      // CONQUEST — only when the owner keeps no military presence here.
      if ((militaryStrengthByCode.get(owner) || 0) > 0) continue;
      let winner = null;
      for (const [code, strength] of militaryStrengthByCode) {
        if (code === owner || strength <= 0) continue;
        if (!bordersTerritoryOf(rid, code)) continue;
        if (!winner || strength > winner.strength) winner = { code, strength };
      }
      if (winner) ownershipChanges.push({ regionId: rid, from: owner, to: winner.code, kind: "conquest" });
      continue;
    }

    // NEUTRAL land — settle it. A power may escort its own settler with its own
    // army; only a FOREIGN military (a different code) contests the ground.
    const militaryCodes = [...militaryStrengthByCode.keys()];
    const hasForeignMilitary = (code) => militaryCodes.some((mc) => mc !== code);

    // Settlers caught in the open with an enemy army present are lost.
    for (const [code, arr] of settlersByCode) {
      if (hasForeignMilitary(code)) for (const s of arr) removedUnitIds.add(s.id);
    }

    // A power can found here if it has an (uncontested) settler AND already borders the region.
    const canSettle = [...settlersByCode.keys()].filter(
      (code) => !hasForeignMilitary(code) && bordersTerritoryOf(rid, code),
    );
    if (canSettle.length === 1) {
      const code = canSettle[0];
      ownershipChanges.push({ regionId: rid, from: "", to: code, kind: "settle" });
      removedUnitIds.add(settlersByCode.get(code)[0].id); // consume one settler
    }
    // 0 eligible, or >1 competing powers -> region stays neutral this turn.
  }

  for (const change of ownershipChanges) owns[change.regionId] = change.to;
  const nextUnits = units.filter((u) => !removedUnitIds.has(u.id));

  return { ownership: owns, ownershipChanges, units: nextUnits, removedUnitIds: [...removedUnitIds] };
}
