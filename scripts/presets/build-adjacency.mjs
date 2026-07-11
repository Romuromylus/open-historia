/*! Pax Colonia — region adjacency graph.
 *
 * The deterministic expansion mechanic is adjacency-gated: a power may only claim a
 * neutral region that borders land it already owns. This precomputes, for a scenario's
 * regions.geojson, the land-adjacency graph { regionId: [neighborId, ...] } and writes
 * it to the scenario folder as adjacency.json.
 *
 * Method: the seed geometry is built so neighbouring regions keep COINCIDENT border
 * vertices (see scripts/extract-regions.mjs) — so two regions are neighbours iff they
 * share at least one boundary vertex. That is exact and far cheaper than polygon
 * intersection over 3.6k MultiPolygons.
 *
 * It also emits centroids.json { regionId: [lng, lat] } — a representative point per
 * region (the average of its boundary vertices). The deterministic AI uses it only to
 * place a moved unit's map marker; the expansion resolver keys off regionId, not the
 * coordinate, so an average-vertex point (which may sit slightly off a concave region)
 * is good enough and needs no extra geometry pass.
 *
 *   node scripts/presets/build-adjacency.mjs [scenarioId=colonization]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NATIONS } from "./colonization.data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const scenarioId = process.argv[2] || "colonization";
const scenarioDir = path.join(ROOT, "server", "data", "scenarios", scenarioId);
const regionsPath = path.join(scenarioDir, "regions.geojson");
const outPath = path.join(scenarioDir, "adjacency.json");
const centroidsPath = path.join(scenarioDir, "centroids.json");

if (!existsSync(regionsPath)) {
  console.error(`[build-adjacency] ERROR: ${regionsPath} not found — build the scenario first.`);
  process.exit(1);
}

// Yield every [lng, lat] leaf pair from arbitrarily-nested GeoJSON coordinates.
function* eachCoord(coords) {
  if (typeof coords[0] === "number") {
    yield coords;
    return;
  }
  for (const c of coords) yield* eachCoord(c);
}

const fc = JSON.parse(readFileSync(regionsPath, "utf8"));
const features = fc.features ?? [];

// Map each rounded boundary vertex to the set of regions that touch it.
const vertexToRegions = new Map();
const adjacency = {};
const centroids = {}; // regionId -> [lng, lat], average of the region's boundary vertices
for (const f of features) {
  const id = f.properties?.id;
  if (!id || !f.geometry) continue;
  adjacency[id] = new Set();
  const seen = new Set(); // dedupe a region's own repeated vertices
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const [lng, lat] of eachCoord(f.geometry.coordinates)) {
    const key = `${lng.toFixed(6)},${lat.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sumLng += lng;
    sumLat += lat;
    count += 1;
    let set = vertexToRegions.get(key);
    if (!set) {
      set = new Set();
      vertexToRegions.set(key, set);
    }
    set.add(id);
  }
  if (count > 0) {
    centroids[id] = [Number((sumLng / count).toFixed(5)), Number((sumLat / count).toFixed(5))];
  }
}

// Any two regions sharing a boundary vertex are neighbours.
for (const set of vertexToRegions.values()) {
  if (set.size < 2) continue;
  const ids = [...set];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      adjacency[ids[i]]?.add(ids[j]);
      adjacency[ids[j]]?.add(ids[i]);
    }
  }
}

// Serialize as sorted arrays.
const out = {};
let edgeCount = 0;
let orphanCount = 0;
const neighborCounts = [];
for (const [id, set] of Object.entries(adjacency)) {
  const list = [...set].sort();
  out[id] = list;
  edgeCount += list.length;
  neighborCounts.push(list.length);
  if (list.length === 0) orphanCount += 1;
}
writeFileSync(outPath, JSON.stringify(out), "utf8");
writeFileSync(centroidsPath, JSON.stringify(centroids), "utf8");

// ── Validation report ────────────────────────────────────────────────────────
const total = neighborCounts.length;
const avg = total ? (edgeCount / total).toFixed(2) : 0;
const max = neighborCounts.length ? Math.max(...neighborCounts) : 0;
console.log(`[build-adjacency] "${scenarioId}" -> ${path.relative(ROOT, outPath)} + ${path.relative(ROOT, centroidsPath)}`);
console.log(`  regions: ${total}  |  undirected edges: ${edgeCount / 2}  |  avg neighbours: ${avg}  |  max: ${max}`);
console.log(`  orphan regions (0 land neighbours): ${orphanCount} (${((orphanCount / total) * 100).toFixed(1)}% — islands/exclaves, expected)`);
console.log(`  starting regions:`);
for (const n of NATIONS) {
  const nbrs = out[n.region];
  const tag = !nbrs ? "MISSING FROM MAP" : nbrs.length === 0 ? "!! DEAD-END (island)" : `${nbrs.length} neighbours`;
  console.log(`    ${n.code.padEnd(9)} ${n.region.padEnd(10)} ${tag}`);
}
