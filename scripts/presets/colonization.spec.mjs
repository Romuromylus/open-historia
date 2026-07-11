/*! Pax Colonia — colonization preset spec (c. 500 BCE).
 *
 * Eight invented ancient powers, each starting from a SINGLE city-region in an
 * otherwise-UNCLAIMED world. No countryAssignments and no unassignedKeepModernOwner,
 * so every region the spec does not name resolves to owner:"" (neutral) — the empty
 * world the powers colonize. Build with:
 *   node scripts/presets/build-preset.mjs scripts/presets/colonization.spec.mjs
 *   node scripts/presets/colonization-postbuild.mjs
 */

import { NATIONS, START_DATE, PLAYER_DEFAULT } from "./colonization.data.mjs";

const polities = {};
const regionAssignments = {};
const cities = [];
for (const n of NATIONS) {
  polities[n.code] = { name: n.name, color: n.color, aliases: n.aliases, note: n.note };
  regionAssignments[n.region] = n.code;
  cities.push([n.capital, n.coord, 4, 20000]); // tier 4 = great-power capital ★
}

// A one-line roster of each power's temperament, folded into the simulation rules so the
// LLM's narration matches how the deterministic AI (src/runtime/aiTurn.js) actually plays them.
const temperamentRoster = NATIONS
  .map((n) => `the ${n.name} ${n.personality.blurb}`)
  .join("; ");

export default {
  id: "colonization",

  meta: {
    name: "Pax Colonia",
    heroTitle: "Pax Colonia",
    heroSubtitle: "Eight cities. One world to claim.",
    eyebrow: "Colonization",
    subtitle: "Dawn of Empires — c. 500 BCE",
    accentColor: "#c9a227",
    coverImage: "public/loading_screen_3.jpg",
    description:
      "The dawn of empires. Across a world still trackless and unclaimed, eight cities kindle " +
      "the first fires of civilization — each a single walled town with a hinterland to tame. " +
      "Send out colonists and armies to settle neighbouring lands, raise walls against rivals, " +
      "and grow a lone city into an empire that spans the map. There are no borders yet but the " +
      "ones you draw.",
  },

  // Player's default faction (the New Game picker still lists all eight).
  // BCE dates are plain text — the timeline shows them verbatim and the AI advances them.
  game: { country: PLAYER_DEFAULT, startDate: START_DATE, gameDate: START_DATE },

  // Ancient/classical warfare: massed infantry, cavalry & chariots ("armor"),
  // siege engines ("artillery"), war galleys and city garrisons. No air. Plus the
  // "settler" colonist — consumed to found a colony on adjacent unclaimed land.
  allowedUnitTypes: ["infantry", "armor", "artillery", "naval", "garrison", "settler"],

  polities,

  // Each power holds exactly ONE region; everything else is unclaimed neutral land.
  regionAssignments,

  cities,

  simulationRules:
    "This is c. 500 BCE. Eight fledgling powers each begin holding a SINGLE city-region in a " +
    "vast, mostly UNCLAIMED world. Powers grow chiefly by sending colonists and armies into " +
    "neighbouring unclaimed land, and less often by warring with rivals they eventually reach. " +
    "Keep everything ANCIENT: bronze and iron arms, infantry, cavalry and chariots, war galleys, " +
    "city walls and siege works — no gunpowder and no modern technology. Armies are small (hundreds " +
    "to a few thousand) and logistics are slow, so expansion is gradual and region-by-region, not " +
    "sweeping. Early on the powers are far apart, so most turns are about local growth into empty " +
    "land rather than direct war between powers. Each power has its own temperament: " +
    temperamentRoster +
    ". Let these temperaments drive who settles peacefully and who marches on its neighbours.",

  startingTimelineText:
    "In an age when most of the world is wilderness, eight cities light the first fires of empire: " +
    "the Aurelian Hegemony on its western peninsula, the seafaring Thalassine League, the river " +
    "priest-kings of Nyros, the Erethian city-builders of the twin rivers, the Suryavani of the great " +
    "plain, the Tianxu of the loess plateau, the Ashkani horse-lords of the savannah, and the Q'entar " +
    "of the high mountains. Each holds a single city and the land it can see. Beyond lies an empty " +
    "world, waiting to be claimed.",
};
