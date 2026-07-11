/* Pax Colonia — shared definition of the eight starting powers.
 *
 * Each invented power begins holding exactly ONE region (its capital city-region)
 * in an otherwise-unclaimed ancient world, and expands outward from there.
 * `region` is a real GADM GID_1 (validated against regions.pmtiles by build-preset);
 * `coord` is [lng, lat] of the capital city. Shared by colonization.spec.mjs (scenario
 * generation) and colonization-postbuild.mjs (starting units) so there is one source of truth.
 *
 * `personality` gives each AI power a distinct temperament that drives the deterministic
 * expansion AI (src/runtime/aiTurn.js) and colours the LLM's narration. Three weights, each
 * 0..1, are the levers:
 *   aggression — appetite for CONQUEST: how readily it marches armies at neighbours it reaches.
 *   expansion  — appetite for SETTLEMENT: how many settlers it raises and how far it flings them
 *                into unclaimed land.
 *   caution    — self-preservation: how much force it holds back to garrison what it already owns
 *                (high caution = defends hard, strikes late; low caution = commits everything forward).
 * `archetype` and `blurb` are flavour the narration prompt can lean on so the story matches the map.
 */

export const START_DATE = "500 BCE";
export const PLAYER_DEFAULT = "AURELIA";

export const NATIONS = [
  {
    code: "AURELIA", name: "Aurelian Hegemony", region: "ITA.8_1", capital: "Aurel", coord: [12.48, 41.90],
    color: "#c0392b", aliases: ["Aurelia", "the Hegemony"],
    note: "Disciplined legions and road-builders of the western peninsula; expand by planting fortified colonies.",
    personality: {
      archetype: "Methodical Expansionist", aggression: 0.55, expansion: 0.75, caution: 0.55,
      blurb: "advances in disciplined steps, fortifying each new colony before reaching for the next",
    },
  },
  {
    code: "THALASSA", name: "Thalassine League", region: "GRC.3_1", capital: "Thalos", coord: [23.73, 37.98],
    color: "#2980b9", aliases: ["Thalassa", "the League"],
    note: "Seafaring traders and colonists of the inner sea; spread along coasts and islands.",
    personality: {
      archetype: "Peaceful Colonizer", aggression: 0.25, expansion: 0.90, caution: 0.35,
      blurb: "prefers trade and settlement to war, seeding colonies wide along coasts and islands",
    },
  },
  {
    code: "NYROS", name: "Nyros Dominion", region: "EGY.11_1", capital: "Nyra", coord: [31.24, 30.05],
    color: "#f1c40f", aliases: ["Nyros", "the Dominion"],
    note: "River-valley priest-kings whose granaries feed vast levies; expand up and down the great river.",
    personality: {
      archetype: "Entrenched Powerhouse", aggression: 0.45, expansion: 0.60, caution: 0.75,
      blurb: "grows deliberately but fields large levies, defending its river heartland fiercely",
    },
  },
  {
    code: "ERETHIA", name: "Erethian Empire", region: "IRQ.10_1", capital: "Ereth", coord: [44.36, 33.31],
    color: "#8e44ad", aliases: ["Erethia", "the Twin Rivers"],
    note: "Ancient city-builders and astronomers of the twin rivers; expand by canal, wall and conquest.",
    personality: {
      archetype: "Warlike Conqueror", aggression: 0.90, expansion: 0.50, caution: 0.30,
      blurb: "the aggressor of the age, quick to march on any neighbour it can reach",
    },
  },
  {
    code: "SURYAVA", name: "Suryavani Realm", region: "IND.34_1", capital: "Suryapur", coord: [80.95, 26.85],
    color: "#e67e22", aliases: ["Suryava", "the Sun Realm"],
    note: "Sun-worshipping dynasts of the great plain; expand along the sacred rivers.",
    personality: {
      archetype: "Balanced Dynasty", aggression: 0.50, expansion: 0.65, caution: 0.50,
      blurb: "a steady, balanced power that settles and wars in equal measure",
    },
  },
  {
    code: "TIANXU", name: "Tianxu Mandate", region: "CHN.22_1", capital: "Tianxu", coord: [108.94, 34.34],
    color: "#27ae60", aliases: ["Tianxu", "the Mandate"],
    note: "Heaven-mandated bureaucrats of the loess plateau; expand by wall, canal and settled farmland.",
    personality: {
      archetype: "Cautious Consolidator", aggression: 0.35, expansion: 0.70, caution: 0.85,
      blurb: "walls its borders and consolidates farmland, rarely striking first",
    },
  },
  {
    code: "ASHKANI", name: "Ashkani Confederation", region: "NGA.31_1", capital: "Ashka", coord: [3.90, 7.85],
    color: "#16a085", aliases: ["Ashkani", "the Confederation"],
    note: "Ironworking savannah horse-lords; expand across grasslands with cavalry and gold.",
    personality: {
      archetype: "Mobile Raider", aggression: 0.80, expansion: 0.70, caution: 0.20,
      blurb: "fast and fearless, raiding and claiming open grassland with cavalry",
    },
  },
  {
    code: "QENTAR", name: "Q'entar Ascendancy", region: "PER.8_1", capital: "Q'entar", coord: [-71.97, -13.53],
    color: "#e84393", aliases: ["Qentar", "the Ascendancy"],
    note: "Highland terrace-builders of the great mountains; expand along the peaks and valleys.",
    personality: {
      archetype: "Reclusive Highlander", aggression: 0.30, expansion: 0.50, caution: 0.85,
      blurb: "keeps to the high mountains, expanding slowly and shunning open war",
    },
  },
];
