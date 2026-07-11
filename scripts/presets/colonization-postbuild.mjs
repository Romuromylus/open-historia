/*! Pax Colonia — starting-units + AI-temperament post-build.
 *
 * build-preset.mjs writes no units, so after generating the colonization scenario we
 * seed each power with a small starting force at its capital: a garrison to hold the
 * city, a host to expand/fight with, and a settler to found its first colony. We also
 * write world.behaviors — the per-power temperament map the deterministic expansion AI
 * (src/runtime/aiTurn.js) reads each turn, and inject the ${deterministicTerritoryChanges}
 * directive into the scenario's jump prompts so the LLM narrates the engine's settlements and
 * conquests. Idempotent — replaces world.units/behaviors wholesale and skips prompt injection
 * when already present — so it is safe to re-run after every build. Run AFTER build-preset.mjs.
 * (world.behaviors survives normalizeWorldState's spread of unknown keys.)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NATIONS } from "./colonization.data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const scenarioDir = path.join(ROOT, "server", "data", "scenarios", "colonization");
const worldPath = path.join(scenarioDir, "world.json");
const promptsPath = path.join(scenarioDir, "prompts.json");

if (!existsSync(worldPath)) {
  console.error(`[colonization-postbuild] ERROR: ${worldPath} not found — run build-preset.mjs first.`);
  process.exit(1);
}

const world = JSON.parse(readFileSync(worldPath, "utf8"));
const now = new Date().toISOString();

const units = [];
const behaviors = {};
for (const n of NATIONS) {
  const [lng, lat] = n.coord;
  units.push({
    id: `start-${n.code}-garrison`,
    name: `${n.capital} Garrison`,
    type: "garrison",
    ownerCode: n.code,
    strength: 120,
    lng,
    lat,
    regionId: n.region,
    status: "idle",
    source: "scenario",
    createdAt: now,
    updatedAt: now,
  });
  units.push({
    id: `start-${n.code}-host`,
    name: `${n.name} Host`,
    type: "infantry",
    ownerCode: n.code,
    strength: 100,
    lng: lng + 0.15,
    lat: lat + 0.15,
    regionId: n.region,
    status: "idle",
    source: "scenario",
    createdAt: now,
    updatedAt: now,
  });
  units.push({
    // A settler is a non-combat colonist; strength is nominal but must stay > 0 or
    // applyUnitOps' final filter would drop it. The AI marches it into adjacent
    // neutral land, where the expansion resolver consumes it to found a colony.
    id: `start-${n.code}-settler`,
    name: `${n.name} Settlers`,
    type: "settler",
    ownerCode: n.code,
    strength: 10,
    lng: lng - 0.15,
    lat: lat - 0.15,
    regionId: n.region,
    status: "idle",
    source: "scenario",
    createdAt: now,
    updatedAt: now,
  });

  // Structured temperament for the deterministic AI (levers documented in colonization.data.mjs).
  behaviors[n.code] = { ...n.personality };
}

world.units = units;
world.behaviors = behaviors;
writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`, "utf8");
console.log(
  `[colonization-postbuild] wrote ${units.length} starting units and ${Object.keys(behaviors).length} temperament profiles for ${NATIONS.length} powers`,
);

// ── Inject the deterministic-territory directive into the jump prompts ────────────
// build-preset copies prompts.json verbatim from the default scenario, so we add the
// ${deterministicTerritoryChanges} placeholder here (colonization-only, leaving the stock
// scenario untouched). gameplay.js fills it with the engine's settlements/conquests so the
// narration matches the map. Idempotent via the marker check.
const ANCHOR = "Output ONLY the JSON object";
const MARKER = "deterministicTerritoryChanges";
const DIRECTIVE =
  "ENGINE-RESOLVED TERRITORY THIS TURN (authoritative): ${deterministicTerritoryChanges}\n" +
  "Treat these settlement and conquest outcomes as ALREADY FINAL: narrate them as events in your " +
  "output, and never reverse or contradict them. You may still emit impacts.regionTransfers for OTHER " +
  "changes your narrative introduces (rebellions, diplomatic cessions), but do not restate or undo the " +
  "engine outcomes above.\n\n";

const injectDirective = (text) => {
  if (typeof text !== "string" || text.length === 0 || text.includes(MARKER)) return { text, changed: false };
  const at = text.indexOf(ANCHOR);
  return at === -1
    ? { text: `${text}\n\n${DIRECTIVE}`, changed: true }
    : { text: `${text.slice(0, at)}${DIRECTIVE}${text.slice(at)}`, changed: true };
};

if (existsSync(promptsPath)) {
  const raw = readFileSync(promptsPath, "utf8");
  const indent = raw.includes('\n  "') ? 2 : raw.includes('\n    "') ? 4 : 0;
  const prompts = JSON.parse(raw);
  let injected = 0;
  for (const key of ["jumpForward", "autoJumpForward"]) {
    for (const holder of [prompts, prompts.tasks].filter(Boolean)) {
      const r = injectDirective(holder[key]);
      if (r.changed) { holder[key] = r.text; injected += 1; }
    }
  }
  writeFileSync(promptsPath, JSON.stringify(prompts, null, indent || undefined), "utf8");
  console.log(`[colonization-postbuild] jump-prompt injections: ${injected} (already-present slots skipped)`);
} else {
  console.warn(`[colonization-postbuild] WARN: ${promptsPath} not found — skipped prompt injection`);
}
