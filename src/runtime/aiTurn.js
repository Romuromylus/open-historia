/*! Pax Colonia — deterministic AI turn planner.
 *
 * Each turn, before the expansion resolver finalizes territory, every AI power issues
 * orders here: it marches its settlers into unclaimed border land, commits a share of its
 * armies against enemies it can reach, and raises fresh forces at home. What it does is
 * driven entirely by its temperament (world.behaviors[code], authored in
 * scripts/presets/colonization.data.mjs) through three 0..1 levers:
 *
 *   expansion  — how many settlers it keeps in flight and how eagerly it raises more.
 *   aggression — what fraction of its mobile army it throws at bordering enemies, and how
 *                fast it raises new troops.
 *   caution    — how much force it holds back to defend; damps aggression and adds garrisons.
 *
 * Pure and deterministic: no clock, no RNG. Tie-breaks are by sorted regionId and by the
 * turn `round`, so the same inputs always yield the same orders (fully unit-testable). The
 * caller applies the returned `units` and then runs resolveExpansion() on them.
 *
 * Note: newly SPAWNED units are appended after movement, so a unit raised this turn does not
 * also move/settle this turn — it musters now and marches next turn, which reads as travel.
 */

const DEFAULT_BEHAVIOR = { aggression: 0.5, expansion: 0.5, caution: 0.5 };
const MOBILE_MILITARY = new Set(["infantry", "armor", "artillery", "naval"]);

const isSettler = (type) => type === "settler";
const isMobileMilitary = (type) => MOBILE_MILITARY.has(type);

// A stable numeric period from a 0..1 lever: high → every turn, mid → every 2, low → every 3.
const periodFor = (weight, hi = 0.7, mid = 0.4) => (weight >= hi ? 1 : weight >= mid ? 2 : 3);

/**
 * @param {object} args
 * @param {Record<string,string>}   args.ownership   regionId -> ownerCode ("" / missing = neutral)
 * @param {Array<object>}           args.units       world.units[]
 * @param {Record<string,string[]>} args.adjacency   regionId -> [neighborRegionId]
 * @param {Record<string,[number,number]>} args.centroids regionId -> [lng, lat] (marker placement only)
 * @param {Record<string,object>}   args.behaviors   ownerCode -> {aggression,expansion,caution}
 * @param {string}                  args.playerCode  the human player's code (never ordered here)
 * @param {number}                  args.round       current turn number (drives production cadence)
 * @returns {{units:Array<object>, orders:Array<object>}}
 */
export function planAiTurn({ ownership, units, adjacency, centroids = {}, behaviors = {}, playerCode, round = 1 }) {
  const ownerOf = (rid) => ownership[rid] || "";
  const neighborsOf = (rid) => adjacency[rid] || [];
  const coordOf = (rid) => centroids[rid] || null;

  // Owned regions per power, and the set of AI powers with any land.
  const ownedByCode = new Map(); // code -> regionId[]
  for (const [rid, code] of Object.entries(ownership)) {
    if (!code) continue;
    if (!ownedByCode.has(code)) ownedByCode.set(code, []);
    ownedByCode.get(code).push(rid);
  }

  // Work on a shallow-cloned unit list we can mutate in place.
  const nextUnits = units.map((u) => ({ ...u }));
  const unitsByCode = new Map(); // code -> units[]
  for (const u of nextUnits) {
    if (!u.ownerCode) continue;
    if (!unitsByCode.has(u.ownerCode)) unitsByCode.set(u.ownerCode, []);
    unitsByCode.get(u.ownerCode).push(u);
  }

  const orders = [];
  const spawned = [];

  // Deterministic power order so tie-breaks are reproducible.
  const codes = [...ownedByCode.keys()].filter((c) => c !== playerCode).sort();

  for (const code of codes) {
    const owned = ownedByCode.get(code) || [];
    if (owned.length === 0) continue; // eliminated
    const p = { ...DEFAULT_BEHAVIOR, ...(behaviors[code] || {}) };
    const ownedSet = new Set(owned);

    // Frontier: neutral border regions (settle targets) and enemy border regions (conquest targets).
    const neutralFrontier = new Set();
    const enemyFrontier = new Set();
    for (const rid of owned) {
      for (const n of neighborsOf(rid)) {
        const o = ownerOf(n);
        if (!o) neutralFrontier.add(n);
        else if (o !== code) enemyFrontier.add(n);
      }
    }
    const neutralTargets = [...neutralFrontier].sort();
    const enemyTargets = [...enemyFrontier].sort();

    const myUnits = unitsByCode.get(code) || [];
    const settlers = myUnits.filter((u) => isSettler(u.type));
    const mobile = myUnits.filter((u) => isMobileMilitary(u.type));
    const garrisons = myUnits.filter((u) => u.type === "garrison");

    // Muster region: the owned region touching the most frontier, so production feeds growth.
    const muster = owned
      .map((rid) => ({
        rid,
        heat: neighborsOf(rid).filter((n) => ownerOf(n) !== code).length,
      }))
      .sort((a, b) => b.heat - a.heat || (a.rid < b.rid ? -1 : 1))[0]?.rid;

    // ── Settler movement — march each idle settler onto a distinct claimable border region.
    const claimedTargets = new Set();
    for (const s of settlers) {
      // Already sitting on a claimable neutral border region → let the resolver settle it.
      if (!ownerOf(s.regionId) && neutralFrontier.has(s.regionId)) {
        claimedTargets.add(s.regionId);
        continue;
      }
      const target = neutralTargets.find((t) => !claimedTargets.has(t));
      if (!target) continue; // nowhere to go — hold
      claimedTargets.add(target);
      moveUnit(s, target, coordOf(target));
      orders.push({ code, kind: "settle-march", unitId: s.id, to: target });
    }

    // ── Army commitment — throw an aggression-scaled share at bordering enemies; caution holds one back.
    if (enemyTargets.length > 0 && mobile.length > 0) {
      let commit = Math.round(mobile.length * p.aggression);
      if (p.caution >= 0.7) commit = Math.max(0, commit - 1); // keep a defender at home
      const strongestFirst = [...mobile].sort((a, b) => (b.strength || 0) - (a.strength || 0));
      for (let i = 0; i < commit; i += 1) {
        const army = strongestFirst[i];
        if (!army) break;
        // Already pressing an enemy region → keep it there for the resolver.
        if (enemyFrontier.has(army.regionId)) continue;
        const target = enemyTargets[i % enemyTargets.length];
        moveUnit(army, target, coordOf(target));
        orders.push({ code, kind: "assault", unitId: army.id, to: target });
      }
    }

    // ── Production — cadence and targets scale with temperament and empire size.
    const totalUnits = myUnits.length + spawned.filter((u) => u.ownerCode === code).length;
    const unitCap = 4 + owned.length; // soft ceiling so no power runs away with unit spam
    const musterCoord = muster ? coordOf(muster) || fallbackCoord(myUnits) : fallbackCoord(myUnits);

    const raise = (type, strength, name) => {
      const seq = spawned.filter((u) => u.ownerCode === code).length + 1;
      const [lng, lat] = musterCoord || [0, 0];
      const unit = {
        id: `ai-${code}-${type}-r${round}-${seq}`,
        name,
        type,
        ownerCode: code,
        strength,
        lng,
        lat,
        regionId: muster || owned[0],
        status: "idle",
        source: "ai",
      };
      spawned.push(unit);
      orders.push({ code, kind: "raise", unitId: unit.id, unitType: type });
      return unit;
    };

    // Settlers — keep a temperament-scaled number in flight while there is empty land to take.
    const desiredSettlers = p.expansion >= 0.75 ? 3 : p.expansion >= 0.5 ? 2 : 1;
    if (
      neutralTargets.length > 0 &&
      settlers.length < desiredSettlers &&
      totalUnits < unitCap &&
      round % periodFor(p.expansion) === 0
    ) {
      raise("settler", 10, `${code} Settlers`);
    }

    // Troops — aggressive powers muster faster and keep a larger standing army.
    const armyTarget = Math.round(2 + p.aggression * 4);
    if (mobile.length < armyTarget && totalUnits + countSpawned(spawned, code) < unitCap && round % periodFor(p.aggression) === 0) {
      raise("infantry", 100, `${code} Host`);
    }

    // Garrisons — cautious powers wall their holdings.
    if (p.caution >= 0.7 && garrisons.length < owned.length && totalUnits + countSpawned(spawned, code) < unitCap && round % 3 === 0) {
      raise("garrison", 120, `${code} Garrison`);
    }
  }

  return { units: [...nextUnits, ...spawned], orders };
}

function moveUnit(unit, regionId, coord) {
  unit.regionId = regionId;
  unit.status = "moving";
  if (coord) {
    unit.lng = coord[0];
    unit.lat = coord[1];
  }
}

function countSpawned(spawned, code) {
  return spawned.filter((u) => u.ownerCode === code).length;
}

function fallbackCoord(units) {
  const u = units[0];
  return u ? [u.lng, u.lat] : null;
}
