# Pax Colonia — Project Plan (Open Historia base)

A self-hosted colonization grand-strategy game built **on top of [Open Historia](https://github.com/Open-Historia/open-historia)** (MIT), an open-source Pax Historia alternative. The player and N AI nations each start owning **one region** on the real world map and expand outward into neutral/enemy territory. An LLM (any OpenAI-compatible endpoint) narrates turns, diplomacy, and events; a **new deterministic engine** owns territory changes.

> **Pivot note (2026-07-11):** The original plan was to build from scratch (7 phases, custom engine). We discovered Open Historia already provides ~90% of the requirements: world map (MapLibre + pmtiles), diplomacy chat, AI events/advisor, troops/combat, a data-driven scenario system, and — critically — **a built-in "OpenAI Compatible" provider so a custom endpoint works with zero code changes.** We adopt it as the base. The from-scratch scaffold was discarded.

---

## 1. Locked decisions

| Decision | Choice |
|---|---|
| Base | Fork/adopt **Open Historia** (MIT) — `github.com/Open-Historia/open-historia`. Keep its branding & feature set (no rebrand). |
| Custom LLM | Its native **OpenAI-compatible** provider (base URL / key / model), routed through the server's `/api/ai/relay`. We add a **server-side default** so the deployed instance uses the user's endpoint without per-browser setup. |
| Colonization start | Author a custom **scenario** via the preset pipeline: player + N AI nations each own exactly **one region**, everything else **neutral** (`owner:""`, already first-class). |
| Expansion mechanic | **Deterministic engine rules** (user-chosen) — new code. Territory is claimed by hard rules (adjacency + uncontested troop presence over N turns for neutral land; besiege/capture for enemy land), not by LLM whim. LLM narrates what the engine decides. |
| Hosting | EasyPanel (git-source Docker app). Persistent volume on `server/data`; basicAuth for the private URL. |

## 2. How the base works (verified by source investigation)

- **Stack**: React 19 + Vite 7 client, single Express 5 server (`server/server.js`). Only runtime npm dep is `express`; all state is JSON files under `server/data/`. No DB, no websockets. Map = MapLibre GL + local `.pmtiles`/`.geojson` (self-hosted).
- **AI layer** (`src/Game/AI/`): one dispatcher `callAI()` (`main.jsx`) fronts 12 tasks (advisor, diplomacy/leader chat, action suggestions, intel, the turn simulation `jumpForward`/`autoJumpForward`, game-master command, etc.). Provider config lives in browser localStorage (`openai_compatible_endpoint` / `_api_key` / `_model`). Non-native providers POST to the server's `/api/ai/relay` (`server/server.js:505`) to dodge CORS — perfect for a self-hosted endpoint. Non-streaming; "JSON" tasks rely on prompt instructions + a permissive extractor, each with a **deterministic non-AI fallback** so a flaky endpoint never bricks a turn.
- **Turn model**: a turn is a player-initiated **time-jump** (`simulateTimelineJump`/`simulateAutoJump`, `gameplay.js`). It makes ONE LLM call for the whole world, returns `{summary, stopDate, events[…impacts{regionTransfers,polityChanges,unitOps,createdChats}], catalyst}`, then `applySimulationResult()` (`gameplay.js:942`) merges it and calls `applyEventImpactsToWorld()` (`gameState.js:795`) — **the only code that mutates `regionOwnershipOverrides`.** This is our integration seam.
- **Units/combat**: `world.units[] = {id,type,strength,name,lat,lng,ownerCode,status,regionId}`. Combat is deterministic (seeded RNG, `unitCombat.js`), reach is **distance-based** (Haversine + per-type engagement range / move leash scaled by era). **There is no region adjacency graph** — we build one. Today, capturing territory is only *suggested* to the LLM after a won clash; nothing flips ownership automatically. That gap is exactly what Phase 2 fills.
- **Scenarios**: `server/data/scenarios/<id>/` = `regions.geojson` (per-region geometry + baked `owner`), `world.json` (runtime `regionOwnershipOverrides`, `polityOverrides`, `units`, `simulationRules`, `startingTimelineText`, `allowedUnitTypes`), `colors.json`, `game.json` (player country, dates, round), `scenario.json` (cosmetics), `prompts.json` (editable prompt pack). Neutral land (`owner:""`) renders gray as "Unclaimed Territory." Built via `node scripts/presets/build-preset.mjs <spec>.mjs`.
- **Deploy facts**: no Dockerfile exists (we author one). ~196MB of Git-LFS map assets **must resolve during image build** or the map ships broken as pointer stubs. `server/data/` (saves, manifests, custom scenarios) must be a **persistent volume**. Server env: `PORT`, `OH_ALLOW_CROSS_ORIGIN`, `OH_IMPORT_COUNTER_URL`. No auth in-app → front with basicAuth. Not airtight-offline: satellite/ocean basemap imagery is fetched client-side from ESRI/AWS (borders/gameplay data are self-hosted and work regardless).

## 3. Phases

Per orchestration preference: lead plans/reviews, Sonnet executor subagents implement in small scoped pieces. Each phase ends with a testable milestone; user stays in the loop at phase boundaries.

### Phase 0 — Baseline (in progress)
Clone base into project (done, LFS verified). `npm install`, `npm run build`, `node server/server.js`, confirm the stock game runs locally (map renders, can create/play a game). Commit a clean local baseline.
**Milestone**: stock Open Historia runs at localhost:3000 on this machine.

### Phase 1 — Colonization scenario
Write `scripts/presets/colonization.spec.mjs`: player + N AI nations (default 7), each assigned exactly one `regionAssignments` region, no `unassignedKeepModernOwner` (⇒ rest neutral), starting garrison `units` per capital, `simulationRules`/`startingTimelineText` tuned for an expansion narrative. Run `build-preset.mjs`, register in the scenario manifest.
**Milestone**: pick the "Colonization" scenario, see N nations each holding one region on an otherwise-neutral map, playable.

### Phase 2 — Deterministic expansion engine (core new work)
1. **Adjacency**: build-time script → `adjacency.json` for the scenario's regions (turf shared-border test), plus a hand-maintained `straits.json` for sea links so island starts aren't dead ends. Validation for unreachable regions.
2. **Claim resolver** (`src/Game/Map/expansion.js`, new): unit→region occupancy via point-in-polygon (`@turf/boolean-point-in-polygon`, already a dep); per-nation control strength per region; rules: neutral region **adjacent to your territory** + uncontested qualifying presence for N turns ⇒ colonize; enemy region ⇒ besiege/capture per combat outcome. Deterministic, seeded, unit-tested.
3. **Turn hook**: run the resolver inside the turn flow (around `applySimulationResult`/`applyEventImpactsToWorld`), apply changes to `regionOwnershipOverrides` authoritatively, and inject a summary of resolved territory changes into the LLM prompt as ground truth so narration matches the map.
4. Optional: domination %/score win condition + end screen.
**Milestone**: move troops into an adjacent neutral region, end the turn, watch it deterministically flip to your color, with the AI report describing it.

### Phase 3 — Custom endpoint baked in
Add a server-side default for the OpenAI-compatible provider driven by env (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`), injected as client defaults (and/or a server settings store) so the deployed instance uses the user's endpoint out of the box. Verify a real turn round-trips through the endpoint via the relay.
**Milestone**: fresh browser on the deployed instance runs a turn against the user's endpoint with no manual Settings entry.

### Phase 4 — EasyPanel deployment
Multi-stage `Dockerfile` (Node 20/22; build stage resolves Git LFS then `npm run build`; slim runtime stage = built `dist` + `server/` + minimal deps) + `.dockerignore` (exclude `.git`, `node_modules`, `dist`). GitHub repo on the Romuromylus account. EasyPanel git-source service, volume mount on `server/data`, env vars, domain + basicAuth middleware, deploy, full smoke-test playthrough on the live URL.
**Milestone**: Pax Colonia playable at its own domain, using the user's endpoint, saves surviving redeploys.

## 4. Risks & mitigations
- **Git LFS not resolved at image build → broken map** (the #1 deploy blocker). Mitigate: explicit `git lfs pull` (or curl from `media.githubusercontent.com`) in the Dockerfile build stage; assert file sizes post-build.
- **Deterministic resolver vs. LLM disagreement**: engine is authoritative for territory; LLM `regionTransfers` for the colonization mechanic are ignored/subordinated, LLM only narrates engine-decided changes.
- **No adjacency data**: we precompute it (turf) at scenario-build; straits file + validation for islands/exclaves.
- **Weak custom model**: base already has deterministic fallbacks for every AI task; our territory mechanic is fully deterministic and never depends on the model.
- **Public URL, no in-app auth**: basicAuth middleware in EasyPanel/Traefik; relay has no allowlist (fine for single-user private deploy).
- **AI settings in localStorage**: Phase 3 server-side default removes per-browser setup for the deployed instance.

## 5. Env & config surface (deploy)
```
PORT=3000
DATA_DIR/volume     -> mounted at server/data (saves, manifests, custom scenarios)
LLM_BASE_URL=       # user's OpenAI-compatible endpoint (Phase 3, baked server-side)
LLM_API_KEY=
LLM_MODEL=
OH_IMPORT_COUNTER_URL=   # set empty to disable hub import telemetry
# basicAuth handled at the EasyPanel/Traefik layer
```
