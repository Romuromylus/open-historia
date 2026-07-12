/*! Open Historia — portions (briefing dossiers + timeout/fallback hardening) © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import dayjs from "dayjs";
import { callAI } from "./main.jsx";
import {
  GAMEPLAY_PROMPT_DEFAULTS,
  normalizePromptPack,
} from "./gameplayPrompts.js";
import {
  JSON_URLS,
  loadCountryNames,
  loadRegionCatalog,
  readJson,
  writeJson,
} from "../../runtime/assets.js";
import {
  applyEventImpactsToWorld,
  buildActionDisplayText,
  LEDGER_STAT_KEYS,
  normalizeActionEntry,
  normalizeActions,
  normalizeChatEntry,
  normalizeChats,
  normalizeEvents,
  normalizeGameData,
  normalizeWorldState,
  readActionsState,
  summarizePolityLedger,
  readChatsState,
  readEventsState,
  readGameData,
  readGameStateBundle,
  readWorldState,
  writeActionsState,
  writeChatsState,
  writeEventsState,
  writeGameData,
  writeWorldState,
} from "../../runtime/gameState.js";
import { difficultyDirective } from "../../runtime/difficulty.js";
import { resolveExpansion } from "../../runtime/expansion.js";
import { planAiTurn } from "../../runtime/aiTurn.js";
import { resolveRegionTransfers } from "../../runtime/regionTransferResolver.js";
import {
  chunkEvents,
  mergeImpactsByIndex,
  normalizeImpactsPayload,
  validateNarrativePayload,
} from "./turnPipeline.js";

const CHAT_HINT_PATTERNS = [
  /\bchat\b/i,
  /\bconference\b/i,
  /\bcontact\b/i,
  /\bdiplomac/i,
  /\bmeet\b/i,
  /\bmessage\b/i,
  /\bnegotiat/i,
  /\boutreach\b/i,
  /\bparley\b/i,
  /\bpeace talk/i,
  /\breach out\b/i,
  /\bspeak with\b/i,
  /\bsummit\b/i,
  /\btalk to\b/i,
  /\btalks? with\b/i,
  /\bпереговор/i,
  /\bвстрет/i,
  /\bдипломат/i,
  /\bсвяз/i,
  /\bчат/i,
  /\bдоговор/i,
];

const cloneValue = (value) => {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
};

const normalizeString = (value) => String(value ?? "").trim();
const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const sentenceCase = (value) => {
  const text = normalizeString(value);
  if (!text) return "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

const maybeJsonParse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const extractJsonPayload = (rawText) => {
  const direct = maybeJsonParse(rawText);
  if (direct) return direct;

  const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const parsed = maybeJsonParse(fencedMatch[1].trim());
    if (parsed) return parsed;
  }

  const objectMatch = rawText.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    const parsed = maybeJsonParse(objectMatch[0]);
    if (parsed) return parsed;
  }

  const arrayMatch = rawText.match(/\[[\s\S]*\]/);
  if (arrayMatch?.[0]) {
    const parsed = maybeJsonParse(arrayMatch[0]);
    if (parsed) return parsed;
  }

  return null;
};

const renderTemplate = (template, variables) =>
  String(template ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });

const loadPromptCatalog = async ({ force = false } = {}) =>
  normalizePromptPack(await readJson(JSON_URLS.prompts, { defaultValue: {}, force }));

const buildEventHistoryText = (events, { limit = 10 } = {}) => {
  const normalizedEvents = normalizeEvents(events);
  if (normalizedEvents.length === 0) {
    return "No prior events have been recorded yet.";
  }

  return normalizedEvents
    .slice(-limit)
    .map((event) => {
      const date = normalizeString(event.date) || "undated";
      const description = normalizeString(event.description);
      const impactNotes = [];

      if (event.impacts.regionTransfers.length > 0) {
        impactNotes.push(
          `Territorial shifts: ${event.impacts.regionTransfers
            .map((entry) => `${entry.regionName || entry.regionId} -> ${entry.toCode}`)
            .join(", ")}`,
        );
      }

      if (event.impacts.polityChanges.length > 0) {
        impactNotes.push(
          `Polity changes: ${event.impacts.polityChanges
            .map((entry) => `${entry.code}${entry.name ? ` renamed to ${entry.name}` : ""}${entry.color ? ` color ${entry.color}` : ""}`)
            .join(", ")}`,
        );
      }

      return [
        `- ${date}: ${event.title}`,
        description ? `  ${description}` : "",
        impactNotes.length > 0 ? `  ${impactNotes.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
};

const buildChatSummaryText = (chats, { limit = 4 } = {}) => {
  const normalizedChats = normalizeChats(chats);
  if (normalizedChats.length === 0) {
    return "No diplomatic chats are currently recorded.";
  }

  return normalizedChats
    .slice(0, limit)
    .map((chat) => {
      const participants = chat.countries.map((country) => country.name).join(", ");
      const lastMessage = chat.messages.at(-1);
      return `- ${participants}: ${
        lastMessage ? `${lastMessage.speaker || lastMessage.role}: ${lastMessage.text}` : "no messages yet"
      }`;
    })
    .join("\n");
};

const buildActionHistoryText = (actions, { includeResolved = false } = {}) => {
  const normalizedActions = normalizeActions(actions);
  const filteredActions = includeResolved
    ? normalizedActions
    : normalizedActions.filter((action) => action.status === "planned");

  if (filteredActions.length === 0) {
    return includeResolved
      ? "No actions have been recorded yet."
      : "No planned actions are currently queued.";
  }

  return filteredActions
    .map((action) => {
      const kindLabel = action.kind === "chat" ? "chat" : "action";
      const statusLabel = action.status !== "planned" ? ` [${action.status}]` : "";
      return `- (${kindLabel}) ${action.title}${statusLabel}: ${buildActionDisplayText(action)}`;
    })
    .join("\n");
};

const buildTerritorySummary = async (world) => {
  const normalizedWorld = normalizeWorldState(world);
  const regionOverrides = Object.entries(normalizedWorld.regionOwnershipOverrides);

  if (regionOverrides.length === 0) {
    return "No territorial overrides from the base scenario are currently recorded.";
  }

  const regionCatalog = await loadRegionCatalog();
  const regionLookup = new Map(regionCatalog.map((region) => [region.id, region]));

  // Include the region ID next to each name: it is the only place the model
  // sees the map's real id format, which grounds the regionId field of any
  // regionTransfers it emits (names also resolve — see regionTransferResolver).
  const lines = regionOverrides
    .slice(0, 40)
    .map(([regionId, ownerCode]) => {
      const region = regionLookup.get(regionId);
      const regionName = region?.name || regionId;
      const countryName = region?.country ? ` (${region.country})` : "";
      return `- ${regionName} [${regionId}]${countryName} -> ${ownerCode}`;
    });
  if (regionOverrides.length > lines.length) {
    lines.push(`- …and ${regionOverrides.length - lines.length} more region override(s) not listed.`);
  }
  return lines.join("\n");
};

// game.country stores the polity CODE ("GER"); prose shown to the player (and
// every prompt that says "you are playing as ...") should use the display name
// ("Germany"). Scenario polity overrides win, then the stock country catalog,
// then the code itself as a last resort.
const resolvePolityDisplayName = async (code, world) => {
  const normalizedCode = normalizeString(code);
  if (!normalizedCode) return "Unknown polity";
  const override = normalizeWorldState(world).polityOverrides[normalizedCode];
  if (override?.name) return override.name;
  const countries = await loadCountryNames().catch(() => []);
  const match = countries.find(
    (country) => normalizeString(country.code).toLowerCase() === normalizedCode.toLowerCase(),
  );
  return match?.name || normalizedCode;
};

// Case-insensitive lookup into a code-keyed map (polityLedgers / polityOverrides).
// The player code and the codes the model emits don't always match casing, so
// never trust an exact-key hit alone.
const findByCodeInsensitive = (map, code) => {
  const normalized = normalizeString(code);
  if (!normalized || !map || typeof map !== "object") return null;
  if (map[normalized]) return map[normalized];
  const upper = normalized.toUpperCase();
  for (const [key, value] of Object.entries(map)) {
    if (String(key).toUpperCase() === upper) return value;
    if (normalizeString(value?.code).toUpperCase() === upper) return value;
  }
  return null;
};

// Compact ledger view for the world summary: the player's ledger in full, every
// other still-standing polity's ledger crushed to one line, and every defunct
// polity listed as gone (its ledger deliberately withheld). Returns "" when no
// ledgers exist yet so the summary stays unchanged for a fresh game.
const buildLedgerBlock = async (bundle) => {
  const world = normalizeWorldState(bundle.world);
  const ledgers = world.polityLedgers || {};
  const overrides = world.polityOverrides || {};
  const playerCode = normalizeString(bundle.game.country);
  const playerUpper = playerCode.toUpperCase();

  const catalog = mergePolityCatalog(await loadCountryNames().catch(() => []), world);
  const nameByCode = new Map();
  for (const entry of catalog) {
    if (entry.code) nameByCode.set(entry.code.toUpperCase(), entry.name || entry.code);
  }
  const nameOf = (code) => {
    const c = normalizeString(code);
    if (!c) return "";
    return nameByCode.get(c.toUpperCase()) || overrides[c]?.name || c;
  };
  const statLine = (ledger) =>
    LEDGER_STAT_KEYS.map((key) => `${key} ${Number(ledger?.stats?.[key] ?? 50)}`).join(" · ");

  // Defunct = an override whose lifecycle status is no longer "active".
  const defunctCodes = new Set();
  for (const override of Object.values(overrides)) {
    if (override?.status && override.status !== "active") {
      defunctCodes.add(normalizeString(override.code).toUpperCase());
    }
  }

  const sections = [];

  const playerLedger = findByCodeInsensitive(ledgers, playerCode);
  if (playerLedger) {
    const summary = summarizePolityLedger(playerLedger, { maxDevelopments: 30 });
    if (summary) {
      sections.push(`YOUR NATION'S LEDGER (${nameOf(playerCode)}):\n${summary}`);
    }
  }

  const OTHER_CAP = 12;
  const otherLines = [];
  let overflow = 0;
  for (const [code, ledger] of Object.entries(ledgers)) {
    const upper = String(code).toUpperCase();
    if (upper === playerUpper) continue;
    if (defunctCodes.has(upper)) continue;
    if (otherLines.length >= OTHER_CAP) {
      overflow += 1;
      continue;
    }
    const devCount = normalizeArray(ledger.developments).length;
    otherLines.push(
      `- ${nameOf(code)} (${code}): ${statLine(ledger)} — ${devCount} development${devCount === 1 ? "" : "s"}`,
    );
  }
  if (overflow > 0) {
    otherLines.push(`- …and ${overflow} more polity ledger(s) not listed.`);
  }
  if (otherLines.length > 0) {
    sections.push(`OTHER NATIONS' LEDGERS (compressed):\n${otherLines.join("\n")}`);
  }

  const defunctLines = [];
  for (const override of Object.values(overrides)) {
    if (!override?.status || override.status === "active") continue;
    const statusLabel = override.status === "annexed" ? "ANNEXED" : override.status === "collapsed" ? "COLLAPSED" : override.status.toUpperCase();
    const by = override.absorbedBy ? ` by ${nameOf(override.absorbedBy)} (${override.absorbedBy})` : "";
    defunctLines.push(
      `- ${nameOf(override.code)} (${override.code}): ${statusLabel}${by} — no longer exists as an independent actor`,
    );
  }
  if (defunctLines.length > 0) {
    sections.push(
      `DEFUNCT POLITIES (must never act, speak, negotiate, or appear as independent actors):\n${defunctLines.join("\n")}`,
    );
  }

  return sections.join("\n\n");
};

// The player's own ledger in full, for prompts that steer the player rather than
// the world (suggestions, stat sheet). "(none)" when nothing is recorded yet.
const buildPlayerLedgerSummary = (bundle) => {
  const world = normalizeWorldState(bundle.world);
  const ledger = findByCodeInsensitive(world.polityLedgers || {}, bundle.game.country);
  const summary = ledger ? summarizePolityLedger(ledger, { maxDevelopments: 30 }) : "";
  return summary || "(no national ledger recorded yet)";
};

// Chronicle of past rounds: the last ~12 simulationHistory summaries as dated
// lines, OLDEST first / newest last (simulationHistory is stored newest-first).
// Each summary is trimmed so a long campaign can't balloon the prompt. "" when
// no rounds have been simulated yet.
const buildChronicleText = (bundle, { limit = 12, maxChars = 300 } = {}) => {
  const history = normalizeArray(bundle.world?.simulationHistory);
  if (history.length === 0) return "";

  return history
    .slice(0, limit)
    .reverse()
    .map((entry) => {
      const fromDate = normalizeString(entry.fromDate) || "unknown";
      const toDate = normalizeString(entry.toDate || entry.date) || "unknown";
      let summary = normalizeString(entry.summary);
      if (summary.length > maxChars) {
        summary = `${summary.slice(0, maxChars - 1)}…`;
      }
      return `${fromDate} -> ${toDate}: ${summary || "(no summary recorded)"}`;
    })
    .join("\n");
};

// Titles of the last ~30 events — the do-not-repeat list. "" when there are none.
const buildDoNotRepeatTitles = (bundle, { limit = 30 } = {}) => {
  const events = normalizeEvents(bundle.events);
  if (events.length === 0) return "";
  return events
    .slice(-limit)
    .map((event) => `- ${normalizeString(event.title) || "(untitled)"}`)
    .join("\n");
};

// Pack-proof continuity block appended to simulation user messages: the chronicle
// and (optionally) the do-not-repeat contract. Rides in the user message so a
// scenario-bundled prompt pack can't strip it. Empty string when there's nothing
// to say, so early turns stay lean.
const buildContinuitySections = (variables, { includeDoNotRepeat = true } = {}) => {
  const parts = [];
  if (normalizeString(variables.chronicle)) {
    parts.push(`CHRONICLE OF PAST ROUNDS (oldest first, newest last):\n${variables.chronicle}`);
  }
  if (includeDoNotRepeat && normalizeString(variables.doNotRepeatTitles)) {
    parts.push(
      "DO NOT REPEAT — these events have ALREADY happened. Every new event must be a FRESH development that " +
        "advances an ongoing storyline; never re-narrate, restate, or trivially rehash anything in this list or the " +
        `chronicle above:\n${variables.doNotRepeatTitles}`,
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
};

const buildWorldSummary = async (bundle) => {
  const territorySummary = await buildTerritorySummary(bundle.world);
  const polityOverrides = Object.values(normalizeWorldState(bundle.world).polityOverrides);
  const politySummary =
    polityOverrides.length === 0
      ? "No dynamic polity overrides are currently recorded."
      : polityOverrides
          .slice(0, 16)
          .map((entry) =>
            `- ${entry.code}: ${entry.name || entry.code}${entry.color ? ` (${entry.color})` : ""}${
              entry.aliases.length > 0 ? ` aliases ${entry.aliases.join(", ")}` : ""
            }`,
          )
          .join("\n");

  const activeCatalyst = normalizeWorldState(bundle.world).activeCatalyst;
  const catalystSummary = activeCatalyst
    ? `Active catalyst: ${activeCatalyst.title || "untitled"} - ${activeCatalyst.premise || activeCatalyst.opening || ""}`
    : "No active catalyst scene.";

  const playerName = await resolvePolityDisplayName(bundle.game.country, bundle.world);
  const ledgerBlock = await buildLedgerBlock(bundle);
  return [
    `Player polity: ${playerName}${bundle.game.country ? ` (code ${bundle.game.country})` : ""}`,
    `Current round: ${bundle.game.round}`,
    `Current date: ${bundle.game.gameDate || "unknown"}`,
    `Language: ${bundle.world.language || bundle.game.language || "English"}`,
    `Difficulty: ${bundle.game.difficulty || "standard"}`,
    "",
    "Territorial changes from the base scenario:",
    territorySummary,
    "",
    "Dynamic polity overrides:",
    politySummary,
    "",
    catalystSummary,
    // National ledgers (persistent developments + stats) only appear once the
    // engine has recorded any — omitted entirely for a fresh game.
    ...(ledgerBlock ? ["", ledgerBlock] : []),
  ].join("\n");
};

const formatDateReadable = (value) => {
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("D MMMM YYYY") : normalizeString(value);
};

const buildDifficultyGuidance = (difficulty, mode = "general") => {
  // Difficulty ids are stored hyphenated (very-easy / easy / medium / hard /
  // very-hard / impossible — see difficulty.js). Collapse spaces/underscores to
  // hyphens so both the id form and any spaced label match; without this,
  // very-easy, very-hard and impossible all fell through to the neutral default
  // and silently had no effect on the AI.
  const normalizedDifficulty = normalizeString(difficulty).toLowerCase().replace(/[\s_]+/g, "-");
  const intro =
    mode === "chats"
      ? "Diplomatic concessions and cooperation should scale with the difficulty."
      : "Long-term success and geopolitical leverage should scale with the difficulty.";

  switch (normalizedDifficulty) {
    case "very-easy":
      return `${intro} The player can turn even modest preparation into results, and setbacks should stay forgiving.`;
    case "easy":
      return `${intro} The player can convert reasonable preparation into results relatively easily.`;
    case "hard":
      return `${intro} The player should need stronger leverage, preparation, and credibility before major outcomes stick.`;
    case "very-hard":
    case "extreme":
      return `${intro} Major outcomes should require overwhelming preparation, sustained leverage, or unusually favorable conditions.`;
    case "impossible":
      return `${intro} Outcomes should almost never break the player's way without extraordinary, sustained, multi-front effort.`;
    case "medium":
    default:
      return `${intro} Outcomes should feel plausible and earned without becoming static.`;
  }
};

const buildAdvisorHistoryText = (messages, { limit = 18 } = {}) => {
  const normalizedMessages = normalizeArray(messages)
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const role = normalizeString(entry.role || entry.speaker || "message");
      const text = normalizeString(entry.text || entry.content || entry.message);
      if (!text) {
        return null;
      }

      return `${role}: ${text}`;
    })
    .filter(Boolean);

  if (normalizedMessages.length === 0) {
    return "No advisor messages are currently recorded.";
  }

  return normalizedMessages.slice(-limit).join("\n");
};

const buildDetailedChatHistoryText = (chats, { limit = 8 } = {}) => {
  const normalizedChats = normalizeChats(chats);
  if (normalizedChats.length === 0) {
    return "No chats occurred in these rounds.";
  }

  return normalizedChats
    .slice(0, limit)
    .map((chat, index) => {
      const header = `Chat ${index + 1}: ${chat.countries.map((country) => country.name).join(", ")}`;
      const body =
        chat.messages.length > 0
          ? chat.messages
              .slice(-10)
              .map((message) => `${message.speaker || message.role}: ${message.text}`)
              .join("\n")
          : "No messages yet.";
      return `${header}\n${body}`;
    })
    .join("\n\n");
};

const buildRecentRoundsWithDates = (bundle) => {
  const history = normalizeArray(bundle.world?.simulationHistory);

  if (history.length === 0) {
    return `Current round only: ${bundle.game.gameDate || "unknown date"}`;
  }

  return history
    .slice(0, 8)
    .map((entry) => `${entry.fromDate || "unknown"} -> ${entry.toDate || entry.date || "unknown"}`)
    .join("; ");
};

const buildPlayerPolityRegionsText = async (bundle) => {
  const playerCode = normalizeString(bundle.game.country);
  if (!playerCode) {
    return "No player polity is currently set.";
  }

  const world = normalizeWorldState(bundle.world);
  const regionEntries = Object.entries(world.regionOwnershipOverrides);
  if (regionEntries.length === 0) {
    return "No explicit player region override list is currently recorded.";
  }

  const regionCatalog = await loadRegionCatalog();
  const regionLookup = new Map(regionCatalog.map((region) => [region.id, region]));
  const playerRegions = regionEntries
    .filter(([, ownerCode]) => normalizeString(ownerCode).toLowerCase() === playerCode.toLowerCase())
    .slice(0, 24)
    .map(([regionId]) => {
      const region = regionLookup.get(regionId);
      return region?.name || regionId;
    });

  if (playerRegions.length === 0) {
    return "No explicit player region override list is currently recorded.";
  }

  return playerRegions.join(", ");
};

const resolveHelperValues = (helperTemplates, variables) => {
  let resolved = {};

  for (let pass = 0; pass < 2; pass += 1) {
    resolved = Object.fromEntries(
      Object.entries(helperTemplates).map(([key, template]) => [
        key,
        renderTemplate(template, { ...variables, ...resolved }),
      ]),
    );
  }

  return resolved;
};

const buildUnitsSummaryText = (world) => {
  const units = normalizeArray(world?.units);
  if (units.length === 0) {
    return "No military units are currently deployed on the map.";
  }

  return units
    .slice(0, 60)
    .map((unit) => {
      const lat = Number(unit.lat);
      const lng = Number(unit.lng);
      const coords = Number.isFinite(lat) && Number.isFinite(lng)
        ? `lat ${lat.toFixed(2)}, lng ${lng.toFixed(2)}`
        : "unknown location";
      return `- ${unit.name} [id ${unit.id}] (${unit.type}, owner ${unit.ownerCode}, strength ${unit.strength}, status ${unit.status}) at ${coords}${unit.regionId ? `, region ${unit.regionId}` : ""}`;
    })
    .join("\n");
};

const MILITARY_ACTION_PATTERN =
  /\b(troop|army|armies|attack|invade|invasion|deploy|fleet|navy|naval|air force|airforce|bomb|siege|offensive|battalion|regiment|garrison|blockade|mobiliz)/i;

// Reach/logistics doctrine for the AI. Deliberately CONDITIONAL: it only
// rides along when the turn actually involves forces (units on the map or
// military-sounding orders), so peaceful turns don't pay the context cost.
const buildMilitaryFeasibilityText = (world, actionsText) => {
  const hasUnits = normalizeArray(world?.units).length > 0;
  if (!hasUnits && !MILITARY_ACTION_PATTERN.test(actionsText || "")) {
    return "";
  }

  return [
    "",
    "MILITARY FEASIBILITY — test every deploy request, move/attack order and your own unitOps against the era and the unit's type before honoring it:",
    "- Era reach: before ~1500, armies march on foot or horse and cross water only by coastal shipping — intercontinental operations are impossible. ~1500–1850 (age of sail): overseas action needs fleets and friendly ports and takes months. 1850–1945: rail and steamships speed logistics; aircraft stay short-ranged until the 1940s. After 1945: global power projection belongs only to major powers with bases, carriers or allies along the route.",
    "- Unit type: air units are fastest but need airbases or carriers within range and cannot hold ground; naval units move only by sea; infantry, armor and artillery crawl overland and need supply lines; garrisons do not travel.",
    "- Distance: compare the unit's coordinates with the target's. An order beyond plausible reach or pace is NOT executed as given — reject it, or convert it into a partial advance with an event explaining the delay, the transport it would need, or why it failed.",
    "- Never teleport units: each move op may only cover what that unit could actually travel in the elapsed time; long campaigns should progress across several turns.",
  ].join("\n");
};

const buildTemplateVariables = async (
  bundle,
  {
    actionInput = "",
    catalystChoice = "",
    catalystHistory = "",
    catalystOpening = "",
    catalystPremise = "",
    chat = null,
    deterministicTerritoryChanges = "",
    eventsToConsolidate = "",
    gameMasterRequest = "",
    targetDate = "",
  } = {},
) => {
  const normalizedChat = chat && typeof chat === "object" ? normalizeChats([chat])[0] : null;
  const regionCatalog = await loadRegionCatalog();
  const chatHistory =
    normalizedChat?.messages?.map((message) => `${message.speaker || message.role}: ${message.text}`).join("\n") ||
    "No chat history.";
  const chatParticipants = normalizedChat?.countries?.map((country) => country.name).join(", ") || "";
  const lastSpeaker = normalizedChat?.messages?.at(-1)?.speaker || "";
  const date = bundle.game.gameDate || "";
  const target = targetDate || bundle.game.gameDate || "";
  const worldSummary = await buildWorldSummary(bundle);
  const recentEvents = buildEventHistoryText(bundle.events);
  const allActions = buildActionHistoryText(bundle.actions, { includeResolved: true });

  return {
    actionInput,
    advisorMessages: buildAdvisorHistoryText(bundle.advisor || []),
    allActions,
    catalystChoice,
    catalystDate: date,
    catalystHistory,
    catalystPercent:
      normalizeArray(bundle.world?.activeCatalyst?.history).length > 0
        ? `${Math.min(100, normalizeArray(bundle.world?.activeCatalyst?.history).length * 50)}%`
        : "0%",
    catalystOpening,
    catalystPremise,
    // Continuity variables (WP2): the running chronicle of past rounds, the
    // do-not-repeat title list, and the player's own ledger — all ride into the
    // simulation user messages so a scenario prompt pack can't drop them.
    chronicle: buildChronicleText(bundle),
    doNotRepeatTitles: buildDoNotRepeatTitles(bundle),
    playerLedgerSummary: buildPlayerLedgerSummary(bundle),
    chatHistory,
    chatHistoryLong: buildDetailedChatHistoryText(bundle.chats),
    chatParticipants,
    chatSummary: buildChatSummaryText(bundle.chats),
    chatsToConsolidate: buildChatSummaryText(bundle.chats, { limit: 12 }),
    date,
    dateReadable: formatDateReadable(date),
    // Territory the deterministic expansion engine settled/conquered this turn (see
    // simulateTimelineJump). Always present so any prompt may reference it; the jump
    // prompt narrates these as already-final so the story matches the map.
    deterministicTerritoryChanges:
      normalizeString(deterministicTerritoryChanges) ||
      "No territory changed hands through settlement or conquest this turn.",
    difficulty: bundle.game.difficulty || "standard",
    difficultyGuidanceChats: buildDifficultyGuidance(bundle.game.difficulty, "chats"),
    difficultyGuidanceJumpForward: buildDifficultyGuidance(bundle.game.difficulty, "jump"),
    eventsToConsolidate: eventsToConsolidate || buildEventHistoryText(bundle.events, { limit: 12 }),
    gameMasterRequest,
    language: bundle.world.language || bundle.game.language || "English",
    lastSpeaker,
    numberOfRegions: String(regionCatalog.length),
    plannedActions: buildActionHistoryText(bundle.actions),
    playerPolity: await resolvePolityDisplayName(bundle.game.country, bundle.world),
    playerBattalionSummaries: buildUnitsSummaryText(bundle.world),
    // Simulation tasks additionally get the reach/logistics doctrine — but
    // only when forces are actually in play this turn (see the builder).
    unitsSummary:
      buildUnitsSummaryText(bundle.world) +
      buildMilitaryFeasibilityText(bundle.world, buildActionHistoryText(bundle.actions)),
    playerPolityRegions: await buildPlayerPolityRegionsText(bundle),
    recentEvents,
    recentEventsLong: buildEventHistoryText(bundle.events, { limit: 24 }),
    recentRoundsWithDates: buildRecentRoundsWithDates(bundle),
    round: String(bundle.game.round || 1),
    respondingPolityName:
      normalizedChat?.countries.find((country) => country.name !== bundle.game.country)?.name || "",
    simulationRules: normalizeString(bundle.world.simulationRules) || "No extra simulation rules were provided.",
    startDate: bundle.game.startDate || "",
    targetDate: target,
    targetDateReadable: formatDateReadable(target),
    worldBeforeRoundOne:
      normalizeString(bundle.world.startingTimelineText) || "No pre-game world briefing was provided.",
    worldSummary,
    worldSummaryNoCity: worldSummary,
  };
};

const withTimeout = async (promise, timeoutMs, timeoutMessage) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

// Give the AI real time: local/self-hosted models (and reasoning modes) often
// need well over a minute per turn. The old 12s default silently discarded
// their answers and served the canned fallback instead — turns "completed"
// with nothing to show. The UI has spinners; waiting beats silently wrong.
const runJsonTask = async (taskKey, { fallback, timeoutMs = 240000, userMessage, variables }) => {
  const prompts = await loadPromptCatalog();
  const helperValues = resolveHelperValues(prompts.helpers, variables);
  let systemPrompt = renderTemplate(prompts.tasks[taskKey], {
    ...variables,
    ...helperValues,
  });

  // The chosen difficulty steers every simulation task (see runtime/difficulty.js).
  try {
    const game = await readGameData();
    systemPrompt = `${systemPrompt}\n\n${difficultyDirective(game.difficulty)}`;
  } catch {
    // Without game data the task still runs at its default temperament.
  }

  // `fallback` is OPTIONAL. When a caller passes one (descriptionToAction,
  // nextSpeaker, the catalyst tasks), a timeout/parse failure degrades to that
  // deterministic payload. When a caller passes NONE (the jump pipeline, game
  // master, suggestions — where the user rejected canned data), the failure
  // THROWS so the caller can abort the turn without mutating any game state.
  let parsed = null;
  let failureReason = "";
  try {
    const raw = await withTimeout(
      callAI(systemPrompt, [{ role: "user", parts: [{ text: userMessage }] }]),
      timeoutMs,
      `AI task "${taskKey}" timed out.`,
    );
    parsed = extractJsonPayload(raw);
    if (!parsed) {
      failureReason = "response was not parseable JSON";
      console.warn(
        `[ai] task "${taskKey}": ${failureReason}${fallback ? " — using the deterministic fallback." : "."}`,
      );
    }
  } catch (error) {
    failureReason = error?.message || String(error);
    console.warn(
      `[ai] task "${taskKey}" failed (${failureReason})${fallback ? " — using the deterministic fallback." : "."}`,
    );
  }

  if (parsed) {
    return parsed;
  }

  if (!fallback) {
    throw new Error(`AI task "${taskKey}" ${failureReason || "failed"}`);
  }

  // Tag fallback payloads (non-enumerable, so it never serializes into saves):
  // callers can tell the player the AI didn't actually run instead of passing
  // canned events off as a real turn.
  const fallbackPayload = await fallback();
  if (fallbackPayload && typeof fallbackPayload === "object") {
    try {
      Object.defineProperty(fallbackPayload, "__fallback", { value: true });
    } catch {
      // frozen/exotic payloads still work, just untagged
    }
  }
  return fallbackPayload;
};

const mergePolityCatalog = (countryCatalog, world) => {
  const merged = new Map();

  for (const country of countryCatalog) {
    if (!country) continue;
    merged.set((country.code || country.name).toUpperCase(), {
      code: country.code || "",
      name: country.name || country.code || "",
    });
  }

  for (const polity of Object.values(normalizeWorldState(world).polityOverrides)) {
    if (!polity) continue;
    merged.set((polity.code || polity.name).toUpperCase(), {
      code: polity.code,
      name: polity.name || polity.code,
    });

    if (polity.name) {
      merged.set(polity.name.toUpperCase(), {
        code: polity.code,
        name: polity.name,
      });
    }
  }

  return Array.from(merged.values());
};

const resolveInvitees = async (names, world) => {
  const countryCatalog = mergePolityCatalog(await loadCountryNames(), world);
  const lookup = new Map();

  for (const country of countryCatalog) {
    lookup.set((country.name || "").toUpperCase(), country);
    if (country.code) {
      lookup.set(country.code.toUpperCase(), country);
    }
  }

  return names
    .map((name) => lookup.get(normalizeString(name).toUpperCase()) || null)
    .filter(Boolean)
    .map((entry) => ({
      code: entry.code || "",
      name: entry.name || entry.code || "",
    }));
};

const inferInviteeNames = async (text, world, playerCountry = "") => {
  const countryCatalog = mergePolityCatalog(await loadCountryNames(), world);
  const normalizedText = normalizeString(text).toLowerCase();

  return countryCatalog
    .filter((country) => country.name && country.name.toLowerCase() !== normalizeString(playerCountry).toLowerCase())
    .filter((country) => normalizedText.includes(country.name.toLowerCase()))
    .slice(0, 5)
    .map((country) => country.name);
};

const fallbackDescriptionToAction = async (rawInput, bundle) => {
  const trimmed = normalizeString(rawInput);
  const isChat = CHAT_HINT_PATTERNS.some((pattern) => pattern.test(trimmed));
  const inferredInvitees = isChat
    ? // inferInviteeNames excludes the player by display NAME; the raw code never matched.
      await inferInviteeNames(trimmed, bundle.world, await resolvePolityDisplayName(bundle.game.country, bundle.world))
    : [];
  const title = sentenceCase(trimmed.split(/[.!?]/)[0] || trimmed);
  const expandedText = isChat
    ? `${trimmed}. Clarify the objective, the concession you can offer, and the outcome you want before the exchange hardens.`
    : `${trimmed}. Define the instrument, timing, and expected political or military effect so the move can be executed cleanly.`;

  return {
    chatStarter: isChat ? trimmed : "",
    invitees: inferredInvitees,
    kind: isChat ? "chat" : "action",
    text: expandedText.slice(0, 520),
    title: title.length > 72 ? `${title.slice(0, 69)}...` : title,
  };
};

const pickMentionedSpeaker = (messageText, participants, excludedSpeaker) => {
  const normalizedText = normalizeString(messageText).toLowerCase();
  if (!normalizedText) return null;

  return (
    participants.find((country) => {
      if (country.name === excludedSpeaker) return false;
      return normalizedText.includes(country.name.toLowerCase());
    }) ?? null
  );
};

const fallbackNextSpeaker = ({ chat, excludedSpeaker }) => {
  const normalizedChat = normalizeChats([chat])[0];
  if (!normalizedChat) {
    return { nextSpeaker: "" };
  }

  const lastMessage = normalizedChat.messages.at(-1);
  const mentionedSpeaker = pickMentionedSpeaker(lastMessage?.text, normalizedChat.countries, excludedSpeaker);
  if (mentionedSpeaker) {
    return { nextSpeaker: mentionedSpeaker.name };
  }

  const fallbackCountry =
    normalizedChat.countries.find((country) => country.name !== excludedSpeaker) ??
    normalizedChat.countries[0] ??
    { name: "" };

  return {
    nextSpeaker: fallbackCountry.name,
  };
};

const buildGeneratedChat = async (chatLike, linkEventId, world) => {
  const countriesInput = Array.isArray(chatLike?.countries) ? chatLike.countries : [];
  const countryNames = countriesInput
    .map((entry) => (typeof entry === "string" ? entry : entry?.name || entry?.code || ""))
    .filter(Boolean);
  const countries = await resolveInvitees(countryNames, world);

  return normalizeChatEntry({
    countries,
    id: chatLike?.id,
    linkedEventId: linkEventId,
    messages:
      chatLike?.messages && Array.isArray(chatLike.messages)
        ? chatLike.messages
        : chatLike?.openingMessage
        ? [
            {
              code: countries.find((country) => country.name === chatLike.speaker)?.code || countries[0]?.code || "",
              role: "leader",
              speaker: chatLike.speaker || countries[0]?.name || "",
              text: chatLike.openingMessage,
              time: "",
            },
          ]
        : [],
    source: "invitation",
    status: "open",
    title: chatLike?.title || `Chat with ${countries.map((country) => country.name).join(", ")}`,
  });
};

const normalizeGeneratedEvent = (entry, index = 0) => {
  const normalized = normalizeEvents([entry])[0];
  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    id: normalized.id || `generated-event-${index}`,
  };
};

const MAX_ROLLBACK_SNAPSHOTS = 12;

// Persist the PRE-turn state so the cheats menu's "Roll back turn" can restore it.
// A dedicated per-game runtime asset (storage/snapshots.json) — never bundled with
// a scenario or dragged through the 5s poll — capped so a long game can't grow it
// without bound. Purely best-effort: a snapshot failure must never break a turn.
const captureRollbackSnapshot = async ({ round, fromDate, toDate, game, world, events, actions, chat, colors }) => {
  try {
    const prior = await readJson(JSON_URLS.snapshots, { defaultValue: [], force: true }).catch(() => []);
    const list = Array.isArray(prior) ? prior : [];
    const snapshot = {
      id: `snap-${round}-${Date.now()}`,
      round,
      fromDate,
      toDate,
      capturedAt: new Date().toISOString(),
      state: {
        game: cloneValue(game),
        world: cloneValue(world),
        events: cloneValue(events),
        actions: cloneValue(actions),
        chat: cloneValue(chat),
        colors: cloneValue(colors),
      },
    };
    await writeJson(JSON_URLS.snapshots, [snapshot, ...list].slice(0, MAX_ROLLBACK_SNAPSHOTS));
  } catch (error) {
    console.warn("[rollback] snapshot capture failed:", error);
  }
};

// Restore points, newest first (index 0 = undo the most recent turn). Shared by
// the cheats menu and the timeline's Undo control.
export const loadRollbackSnapshots = async () => {
  const list = await readJson(JSON_URLS.snapshots, { defaultValue: [], force: true }).catch(() => []);
  return Array.isArray(list) ? list : [];
};

// Roll back to the start of the turn captured at `index`: restore the six
// per-turn assets, discard that restore point and every newer one (those turns
// no longer happened), and return the freshly-normalized bundle so the caller
// can update immediately. Returns null if there is no such snapshot.
export const rollBackToSnapshot = async (index = 0) => {
  const snapshots = await loadRollbackSnapshots();
  const snap = snapshots[index];
  if (!snap) return null;
  const s = snap.state ?? {};
  await Promise.all([
    writeJson(JSON_URLS.game, s.game ?? {}, { pretty: true }),
    writeJson(JSON_URLS.world, s.world ?? {}, { pretty: true }),
    writeJson(JSON_URLS.events, s.events ?? [], { pretty: true }),
    writeJson(JSON_URLS.actions, s.actions ?? [], { pretty: true }),
    writeJson(JSON_URLS.chat, s.chat ?? [], { pretty: true }),
    writeJson(JSON_URLS.colors, s.colors ?? {}, { pretty: true }),
  ]);
  await writeJson(JSON_URLS.snapshots, snapshots.slice(index + 1));
  const bundle = await readGameStateBundle({ force: true });
  return { bundle, round: snap.round, remaining: snapshots.length - (index + 1) };
};

const applySimulationResult = async ({
  baseActions,
  baseChats,
  baseColors,
  baseEvents,
  baseGame,
  baseWorld,
  result,
}) => {
  const generatedEvents = normalizeArray(result.events)
    .map((entry, index) => normalizeGeneratedEvent(entry, index))
    .filter(Boolean);

  // The model names territory; the map keys ownership by region id. Resolve
  // every generated transfer against the region catalog (exact id, region
  // name, or whole-polity expansion) so narrated conquests actually repaint
  // the map. Ownership is threaded through event-by-event so a later "all of
  // Poland" only moves what earlier events in the same turn left behind.
  // Unresolvable entries are dropped — a dead override colors nothing anyway.
  const regionCatalog = await loadRegionCatalog().catch(() => []);
  if (regionCatalog.length > 0) {
    const normalizedBaseWorld = normalizeWorldState(baseWorld);
    const workingOwnership = { ...normalizedBaseWorld.regionOwnershipOverrides };
    for (const event of generatedEvents) {
      if (event.impacts.regionTransfers.length === 0) continue;
      const { transfers, unresolved } = resolveRegionTransfers(event.impacts.regionTransfers, {
        ownership: workingOwnership,
        polityOverrides: normalizedBaseWorld.polityOverrides,
        regions: regionCatalog,
      });
      if (unresolved.length > 0) {
        console.warn(
          `[ai] ${unresolved.length} region transfer(s) in "${event.title}" matched no map region and were skipped:`,
          unresolved.map((entry) => entry?.regionName || entry?.regionId || "(unnamed)").join(", "),
        );
      }
      event.impacts.regionTransfers = transfers;
      for (const transfer of transfers) {
        workingOwnership[transfer.regionId] = transfer.toCode;
      }
    }
  }

  const nextEvents = [...normalizeEvents(baseEvents), ...generatedEvents];
  const nextGame = normalizeGameData({
    ...baseGame,
    gameDate: normalizeString(result.stopDate) || baseGame.gameDate,
    round: (baseGame.round || 1) + 1,
  });
  const plannedActionSnapshot = normalizeActions(baseActions).filter((action) => action.status === "planned");
  const nextActions = normalizeActions(baseActions).map((action) => ({
    ...action,
    status: action.status === "planned" && result.clearActions ? "resolved" : action.status,
  }));
  const nextChats = [...normalizeChats(baseChats)];

  for (const event of generatedEvents) {
    for (const createdChat of event.impacts.createdChats) {
      const nextChat = await buildGeneratedChat(createdChat, event.id, baseWorld);
      if (nextChat) {
        nextChats.unshift(nextChat);
      }
    }
  }

  const { colors: nextColors, world: worldWithImpacts } = applyEventImpactsToWorld({
    colors: baseColors,
    events: generatedEvents,
    world: {
      ...baseWorld,
      activeCatalyst: result.catalyst ?? null,
      actionSuggestions: [],
      lastJumpMode: normalizeString(result.mode),
      lastJumpSummary: normalizeString(result.summary),
      lastJumpTargetDate: nextGame.gameDate,
      simulationHistory: [
        {
          catalyst: result.catalyst ? cloneValue(result.catalyst) : null,
          date: nextGame.gameDate,
          eventIds: generatedEvents.map((event) => event.id),
          fromDate: baseGame.gameDate,
          mode: normalizeString(result.mode) || "jump",
          plannedActions: plannedActionSnapshot,
          round: nextGame.round,
          summary: normalizeString(result.summary),
          toDate: nextGame.gameDate,
        },
        ...normalizeWorldState(baseWorld).simulationHistory,
      ].slice(0, 12),
    },
  });

  await Promise.all([
    writeActionsState(nextActions),
    writeChatsState(nextChats),
    writeEventsState(nextEvents),
    writeGameData(nextGame),
    writeJson(JSON_URLS.colors, nextColors, { pretty: true }),
    writeWorldState(worldWithImpacts),
  ]);

  // Snapshot the state we just replaced so it can be rolled back to (best-effort).
  await captureRollbackSnapshot({
    round: baseGame.round || 1,
    fromDate: baseGame.gameDate || baseGame.startDate || "",
    toDate: nextGame.gameDate || "",
    game: baseGame,
    world: baseWorld,
    events: baseEvents,
    actions: baseActions,
    chat: baseChats,
    colors: baseColors,
  });

  return {
    actions: nextActions,
    chats: nextChats,
    colors: nextColors,
    events: nextEvents,
    game: nextGame,
    world: worldWithImpacts,
  };
};

export const generateActionSuggestions = async ({ force = true } = {}) => {
  const bundle = await readGameStateBundle({ force });
  const variables = await buildTemplateVariables(bundle);
  // No fallback: the user rejected canned suggestions. A failed generation
  // THROWS a player-facing message; the caller (actions.jsx) shows it without
  // clearing the suggestions already on screen.
  let payload;
  try {
    payload = await runJsonTask("actions", {
    // The action history rides in the user message (not the editable prompt
    // pack) so scenario-bundled prompts can't lose it: without it the model
    // re-suggests moves the player already made, turn after turn.
    userMessage:
      "Generate current strategic action suggestions as JSON only. " +
      "Propose FRESH, forward-looking options: never re-suggest an action the player has already taken or queued " +
      "(full history below), and do not rehash topics the event history shows as settled — advance to the NEXT " +
      "decision each concern calls for. Build on the nation's EXISTING developments and target its current stat " +
      "weaknesses (see the ledger below) rather than restarting from scratch. " +
      "Use polity display names, never internal codes, in all titles and descriptions.\n\n" +
      `PLAYER ACTION HISTORY (do not repeat any of these):\n${variables.allActions}\n\n` +
      `YOUR NATION'S LEDGER (build on these developments, shore up weak stats):\n${variables.playerLedgerSummary}` +
      buildContinuitySections(variables, { includeDoNotRepeat: false }),
    variables,
    });
  } catch (error) {
    console.warn(`[ai] action suggestions failed (${error?.message || error}).`);
    throw new Error("The AI could not produce suggestions — try again.");
  }

  const normalizeTopics = (raw) =>
    normalizeArray(raw)
      .map((topic, topicIndex) => {
        if (!topic || typeof topic !== "object") {
          return null;
        }

        const title = normalizeString(topic.title || topic.name);
        if (!title) {
          return null;
        }

        return {
          actions: normalizeArray(topic.actions)
            .map((action, actionIndex) =>
              normalizeActionEntry(
                {
                  ...action,
                  source: "suggested",
                  suggestionTopic: title,
                },
                actionIndex,
              ),
            )
            .filter(Boolean),
          description: normalizeString(topic.description),
          id: normalizeString(topic.id) || `topic-${topicIndex}`,
          title,
        };
      })
      .filter(Boolean);

  // Models told "JSON only" mislabel or wrap the list — accept the common
  // shapes (top-level array, topics, suggestions) before giving up.
  let topics = normalizeTopics(
    Array.isArray(payload) ? payload : payload?.topics ?? payload?.suggestions,
  );

  // A parseable-but-EMPTY answer is a failed generation, not "no suggestions":
  // fail hard so the caller keeps the current suggestions and shows the error.
  if (topics.length === 0) {
    console.warn("[ai] action suggestions came back empty.");
    throw new Error("The AI could not produce suggestions — try again.");
  }

  const world = normalizeWorldState(await readWorldState());
  world.actionSuggestions = topics;
  await writeWorldState(world);

  return topics;
};

// Freeform AI intelligence briefing on a specific country/polity, grounded in the
// current world state. Returned as plain-text bullet points for the region popup.
// Everything the game state actually records about ONE polity — the target's
// dossier for intelligence briefings. The generic world summary truncates hard
// (24 of possibly thousands of region overrides, 16 polities), so without this
// the target usually isn't in the prompt at all and the AI can only shrug.
const buildTargetDossier = async (bundle, code) => {
  const world = normalizeWorldState(bundle.world);
  const lines = [];

  const polity = code ? world.polityOverrides?.[code] : null;
  if (polity) {
    lines.push(
      `Polity: ${polity.name || code} (code ${code})${
        polity.aliases?.length > 0 ? ` — also known as ${polity.aliases.join(", ")}` : ""
      }`,
    );
    if (polity.note) lines.push(`Notes: ${polity.note}`);
  }

  const overrides = Object.entries(world.regionOwnershipOverrides ?? {});
  const owned = code ? overrides.filter(([, owner]) => owner === code) : [];
  if (owned.length > 0) {
    const regionCatalog = await loadRegionCatalog();
    const regionLookup = new Map(regionCatalog.map((region) => [region.id, region]));
    const names = owned.slice(0, 40).map(([regionId]) => {
      const region = regionLookup.get(regionId);
      return region ? `${region.name}${region.country ? ` (${region.country})` : ""}` : regionId;
    });
    lines.push(
      `Territory: holds ${owned.length} regions${owned.length > names.length ? ", including" : ""}: ${names.join(", ")}${
        owned.length > names.length ? ", …" : ""
      }`,
    );
  } else if (code) {
    lines.push(
      overrides.length > 0
        ? `Territory: no regions on the current map are recorded as held by ${code}.`
        : `Territory: holds its modern-day territory (no territorial changes recorded).`,
    );
  }

  const units = normalizeArray(bundle.world?.units).filter((unit) => unit?.ownerCode === code);
  if (units.length > 0) {
    const byType = new Map();
    let strength = 0;
    for (const unit of units) {
      byType.set(unit.type, (byType.get(unit.type) || 0) + 1);
      strength += Number(unit.strength) || 0;
    }
    const composition = Array.from(byType.entries()).map(([type, n]) => `${n} ${type}`).join(", ");
    lines.push(`Deployed forces: ${units.length} units (${composition}), combined strength ${strength}.`);
  } else {
    lines.push("Deployed forces: none currently on the map.");
  }

  return lines.join("\n");
};

export const generateCountryStats = async ({ code, name } = {}) => {
  const bundle = await readGameStateBundle({ force: true });
  const variables = await buildTemplateVariables(bundle);
  const target = name || code || "the polity";
  const playerPolity = variables.playerPolity || bundle?.game?.country || "the player";
  const dossier = await buildTargetDossier(bundle, normalizeString(code));
  const era = normalizeString(bundle.world?.simulationRules).slice(0, 700);
  const system =
    `You are the intelligence advisor in an alternate-history strategy game. ` +
    `The current date is ${variables.date || "unknown"}. The player leads ${playerPolity}. ` +
    `Give a concise intelligence briefing on ${target}${code ? ` (code ${code})` : ""}. ` +
    `Treat the TARGET DOSSIER and WORLD STATE below as ground truth. Where specifics are not recorded, ` +
    `give your best historical estimate for this era, people and region — you are the advisor, and ` +
    `plausible estimates are your job. Never answer with "unknown", "no data" or "not specified"; ` +
    `mark guesses with "(est.)" instead. ` +
    `Cover government/leadership, territory & key regions, military strength, economy, and diplomatic posture toward ${playerPolity}.\n\n` +
    (era ? `ERA & WORLD RULES:\n${era}\n\n` : "") +
    `TARGET DOSSIER:\n${dossier || "(nothing recorded)"}\n\n` +
    `WORLD STATE:\n${variables.worldSummary || variables.grandMapDescription || "(no summary)"}\n\n` +
    `RECENT EVENTS:\n${variables.recentEvents || "(none)"}\n\n` +
    `Respond in ${variables.language || "English"} as 4-6 short bullet points, each prefixed with "- ". No preamble, no closing remarks.`;
  const raw = await callAI(system, [
    { role: "user", parts: [{ text: `Give me the intelligence briefing on ${target}.` }] },
  ]);
  return String(raw || "").trim();
};

// Structured national stat sheet for the Stats tab: same grounding as the
// intelligence briefing, but strict JSON so the UI can render bars and cards.
export const generateCountryStatSheet = async ({ code, name, priorSheet = null } = {}) => {
  const bundle = await readGameStateBundle({ force: true });
  const variables = await buildTemplateVariables(bundle);
  const target = name || code || "the polity";
  const dossier = await buildTargetDossier(bundle, normalizeString(code));
  const era = normalizeString(bundle.world?.simulationRules).slice(0, 700);

  // Ledger + lifecycle status ground the sheet: the numbers should track the
  // recorded developments and reflect an occupied/annexed polity as such.
  const world = normalizeWorldState(bundle.world);
  const targetCode = normalizeString(code);
  const targetLedger = findByCodeInsensitive(world.polityLedgers || {}, targetCode);
  const ledgerSummary = targetLedger ? summarizePolityLedger(targetLedger, { maxDevelopments: 30 }) : "";
  const targetOverride = findByCodeInsensitive(world.polityOverrides || {}, targetCode);
  const targetStatus = targetOverride?.status || "active";

  // priorSheet anchors evolution: the same code's most recent older sheet, so
  // the numbers drift plausibly instead of being re-rolled from scratch. Absent
  // it, the prompt is unchanged from before (aside from the ledger/status which
  // only appear once the engine has recorded them).
  let priorSheetJson = "";
  if (priorSheet && typeof priorSheet === "object") {
    try {
      priorSheetJson = JSON.stringify(priorSheet);
    } catch {
      priorSheetJson = "";
    }
  }
  const priorSheetDate = normalizeString(priorSheet?.__date || priorSheet?.date);

  const system =
    `You are the statistics bureau of an alternate-history strategy game. ` +
    `The current date is ${variables.date || "unknown"}. ` +
    `Compile a national stat sheet for ${target}${code ? ` (code ${code})` : ""}. ` +
    `Treat the TARGET DOSSIER and WORLD STATE below as ground truth; where specifics are not recorded, ` +
    `give your best historical estimate for this era, people and region — never refuse, never say unknown. ` +
    `Money units must fit the era (barter/tribute-era polities still get best-effort figures).\n\n` +
    (era ? `ERA & WORLD RULES:\n${era}\n\n` : "") +
    `TARGET DOSSIER:\n${dossier || "(nothing recorded)"}\n\n` +
    (ledgerSummary
      ? `NATIONAL LEDGER (ground truth — these developments and stats are real and persist across turns):\n${ledgerSummary}\n\n`
      : "") +
    (targetStatus !== "active"
      ? `STATUS: ${target} is ${targetStatus.toUpperCase()}${targetOverride?.absorbedBy ? ` (absorbed by ${targetOverride.absorbedBy})` : ""} — it no longer exists as an independent state. The sheet must reflect occupation/annexation: collapsed sovereignty and internal security, an economy and military folded into or suppressed by the occupier.\n\n`
      : "") +
    `WORLD STATE:\n${variables.worldSummary || "(no summary)"}\n\n` +
    `RECENT EVENTS:\n${variables.recentEvents || "(none)"}\n\n` +
    (priorSheetJson
      ? `PRIOR STAT SHEET${priorSheetDate ? ` (from ${priorSheetDate})` : ""} — evolve plausibly and GRADUALLY from these numbers given the chronicle, ledger and recent events; do NOT re-roll figures at random, preserve continuity:\n${priorSheetJson}\n\n`
      : "") +
    (priorSheetJson && normalizeString(variables.chronicle)
      ? `CHRONICLE OF PAST ROUNDS:\n${variables.chronicle}\n\n`
      : "") +
    `Respond with ONLY a JSON object — no prose, no markdown fences — exactly this shape:\n` +
    `{"capital":"city","continent":"continent","government":"system · ideology","leader":"head of state/government",` +
    `"stability":0-100 integer,` +
    `"indices":{"sovereignty":0-100,"foodAutonomy":0-100,"energyAutonomy":0-100,"economicIndependence":0-100,"internalSecurity":0-100},` +
    `"economy":{"gdp":"9 B$","gdpGrowth":"+5.2% / yr","gdpPerCapita":"796 $","currency":"XOF",` +
    `"inflation":"0.3%","unemployment":"1%","publicDebt":"47.5% GDP","budgetBalance":"-3.7% GDP"},` +
    `"gdpBreakdown":{"agriculture":24,"industry":24,"services":52}}\n` +
    `gdpBreakdown percentages must sum to 100. ` +
    `Write text values in ${variables.language || "English"}; keep numbers plain.`;
  const raw = await callAI(system, [
    { role: "user", parts: [{ text: `Compile the national stat sheet for ${target}.` }] },
  ]);
  const parsed = extractJsonPayload(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The stat sheet did not come back as valid JSON.");
  }
  return parsed;
};

export const refinePlayerAction = async (rawInput, { persist = true } = {}) => {
  const bundle = await readGameStateBundle({ force: true });
  const variables = await buildTemplateVariables(bundle, { actionInput: rawInput });
  const payload = await runJsonTask("descriptionToAction", {
    fallback: () => fallbackDescriptionToAction(rawInput, bundle),
    userMessage: "Convert the player's raw intent into one structured in-game command as JSON only.",
    variables,
  });

  const invitees = normalizeArray(payload?.invitees).map((entry) => normalizeString(entry)).filter(Boolean);
  const action = normalizeActionEntry({
    chatStarter: normalizeString(payload?.chatStarter),
    invitees,
    kind: normalizeString(payload?.kind).toLowerCase() === "chat" ? "chat" : "action",
    rawInput,
    source: "manual",
    status: "planned",
    text: normalizeString(payload?.text),
    title: normalizeString(payload?.title),
  });

  if (!action) {
    throw new Error("Could not convert the action into a structured command.");
  }

  if (persist) {
    const nextActions = [...(await readActionsState({ force: true })), action];
    await writeActionsState(nextActions);
  }

  return action;
};

export const chooseNextDiplomaticSpeaker = async ({
  chat,
  excludeSpeaker = "",
} = {}) => {
  const bundle = await readGameStateBundle({ force: true });
  const normalizedChat = normalizeChats([chat])[0];
  if (!normalizedChat) {
    return "";
  }

  const variables = await buildTemplateVariables(bundle, { chat: normalizedChat });
  const payload = await runJsonTask("nextSpeaker", {
    fallback: () => fallbackNextSpeaker({ chat: normalizedChat, excludedSpeaker: excludeSpeaker }),
    userMessage: "Choose the next speaker as JSON only.",
    variables: {
      ...variables,
      lastSpeaker: excludeSpeaker || variables.lastSpeaker,
    },
  });

  const nextSpeaker = normalizeString(payload?.nextSpeaker);
  if (!nextSpeaker) {
    return fallbackNextSpeaker({ chat: normalizedChat, excludedSpeaker: excludeSpeaker }).nextSpeaker;
  }

  const validSpeaker =
    normalizedChat.countries.find((country) => country.name.toLowerCase() === nextSpeaker.toLowerCase()) ??
    normalizedChat.countries.find((country) => country.name !== excludeSpeaker);

  return validSpeaker?.name || "";
};

export const consolidateRecentHistory = async ({ limit = 12 } = {}) => {
  const bundle = await readGameStateBundle({ force: true });
  const variables = await buildTemplateVariables(bundle, {
    chatsToConsolidate: buildChatSummaryText(bundle.chats, { limit }),
    eventsToConsolidate: buildEventHistoryText(bundle.events, { limit }),
  });
  const payload = await runJsonTask("eventConsolidator", {
    fallback: () => ({
      summary: `Recent history: ${normalizeEvents(bundle.events)
        .slice(-limit)
        .map((event) => `${event.date || "undated"} ${event.title}`)
        .join("; ")}`,
    }),
    userMessage: "Summarize the recent campaign history as JSON only.",
    variables,
  });

  return normalizeString(payload?.summary);
};

export const createCatalyst = async ({ force = true } = {}) => {
  const bundle = await readGameStateBundle({ force });
  const variables = await buildTemplateVariables(bundle);
  const payload = await runJsonTask("catalystCreation", {
    fallback: () => ({
      choices: [
        "Intervene decisively",
        "Probe for weakness first",
        "Remain cautious and observe",
      ],
      opening: normalizeEvents(bundle.events).at(-1)?.description || "A turning point begins to unfold.",
      premise: normalizeEvents(bundle.events).at(-1)?.title || "A decisive moment takes shape.",
      title: normalizeEvents(bundle.events).at(-1)?.title || "Emerging Catalyst",
    }),
    userMessage: "Design the next catalyst scene as JSON only.",
    variables,
  });

  const catalyst = {
    choices: normalizeArray(payload?.choices).map((entry) => normalizeString(entry)).filter(Boolean).slice(0, 5),
    opening: normalizeString(payload?.opening),
    premise: normalizeString(payload?.premise),
    title: normalizeString(payload?.title),
  };

  const world = normalizeWorldState(await readWorldState({ force: true }));
  world.activeCatalyst = catalyst;
  await writeWorldState(world);
  return catalyst;
};

export const advanceActiveCatalyst = async (choiceText) => {
  const bundle = await readGameStateBundle({ force: true });
  const baseColors = await readJson(JSON_URLS.colors, { defaultValue: {}, force: true });
  const world = normalizeWorldState(bundle.world);
  const catalyst = world.activeCatalyst;

  if (!catalyst) {
    throw new Error("No active catalyst is available.");
  }

  const catalystHistoryText = normalizeArray(catalyst.history)
    .map((entry) => `${entry.choice}: ${entry.summary}`)
    .join("\n");
  const variables = await buildTemplateVariables(bundle, {
    catalystChoice: choiceText,
    catalystHistory: catalystHistoryText,
    catalystOpening: catalyst.opening || "",
    catalystPremise: catalyst.premise || catalyst.title || "",
  });

  const payload = await runJsonTask("catalystExecutor", {
    fallback: () => ({
      nextChoices: normalizeArray(catalyst.choices).slice(0, 3),
      resolved: normalizeArray(catalyst.history).length >= 1,
      summary: `${choiceText} becomes the line of action inside "${catalyst.title || "the scene"}", pushing the situation toward a definite outcome.`,
    }),
    userMessage: "Continue the catalyst scene as JSON only.",
    variables,
  });

  const historyEntry = {
    choice: choiceText,
    summary: normalizeString(payload?.summary),
  };

  const nextCatalyst = {
    ...catalyst,
    choices: normalizeArray(payload?.nextChoices).map((entry) => normalizeString(entry)).filter(Boolean).slice(0, 5),
    history: [...normalizeArray(catalyst.history), historyEntry],
    opening: normalizeString(payload?.summary) || catalyst.opening,
  };

  if (!payload?.resolved) {
    const nextWorld = {
      ...world,
      activeCatalyst: nextCatalyst,
    };
    await writeWorldState(nextWorld);
    return {
      catalyst: nextCatalyst,
      world: nextWorld,
    };
  }

  const summaryVariables = await buildTemplateVariables(bundle, {
    catalystHistory: [...normalizeArray(catalyst.history), historyEntry]
      .map((entry) => `${entry.choice}: ${entry.summary}`)
      .join("\n"),
    catalystPremise: catalyst.premise || catalyst.title || "",
  });
  const summaryPayload = await runJsonTask("catalystSummary", {
    fallback: () => ({
      description: historyEntry.summary,
      importance: "major",
      title: catalyst.title || "Catalyst resolved",
    }),
    userMessage: "Summarize the finished catalyst into one campaign event as JSON only.",
    variables: summaryVariables,
  });

  const catalystEvent = normalizeGeneratedEvent({
    date: bundle.game.gameDate,
    description: normalizeString(summaryPayload?.description),
    impacts: {
      createdChats: [],
      polityChanges: [],
      regionTransfers: [],
    },
    importance: normalizeString(summaryPayload?.importance) || "major",
    kind: "catalyst",
    notable: true,
    playerRelated: true,
    title: normalizeString(summaryPayload?.title) || catalyst.title || "Catalyst resolved",
  });

  return applySimulationResult({
    baseActions: bundle.actions,
    baseChats: bundle.chats,
    baseColors,
    baseEvents: bundle.events,
    baseGame: bundle.game,
    baseWorld: {
      ...bundle.world,
      activeCatalyst: null,
    },
    result: {
      catalyst: null,
      clearActions: false,
      events: catalystEvent ? [catalystEvent] : [],
      mode: "catalyst",
      stopDate: bundle.game.gameDate,
      summary: normalizeString(summaryPayload?.description) || historyEntry.summary,
    },
  });
};

// Event density per skip length (player-tuned): longer skips must return
// proportionally more events, and short ones must stay brief.
const eventCountRangeForDays = (days) => {
  if (days <= 7) return [1, 2];
  if (days <= 31) return [5, 7];
  if (days <= 92) return [10, 13];
  if (days <= 184) return [19, 27];
  return [29, 37];
};

// Pax Colonia's deterministic expansion turn. Runs BEFORE the LLM narrates so the story
// can match the map: the AI powers issue orders (planAiTurn), the resolver finalizes every
// settlement and conquest (resolveExpansion), and the results are folded into `bundle.world`
// (regionOwnershipOverrides + units). Returns a human-readable summary of what changed for the
// jump prompt. A no-op — returns "" and touches nothing — for scenarios that ship no adjacency
// graph (i.e. every stock Open Historia scenario), so this is purely additive to the base game.
const applyDeterministicExpansion = async (bundle) => {
  const adjacency = await readJson(JSON_URLS.adjacency, { defaultValue: {} }).catch(() => ({}));
  // The scenario-geojson fallback serves an empty FeatureCollection when a scenario has no
  // adjacency file; a real graph is a plain { regionId: [...] } map. Gate on that shape.
  const hasAdjacency = adjacency && typeof adjacency === "object" && !adjacency.features && Object.keys(adjacency).length > 0;
  if (!hasAdjacency) return "";

  const centroids = await readJson(JSON_URLS.centroids, { defaultValue: {} }).catch(() => ({}));
  const ownership = { ...(bundle.world.regionOwnershipOverrides || {}) };
  const behaviors = bundle.world.behaviors || {};
  const playerCode = bundle.game.country || "";
  const round = bundle.game.round || 1;

  // Player-deployed units carry lng/lat but no regionId (see unitsController.deployUnit), so
  // give the resolver a nearest-centroid lookup to place them. AI units already carry an exact
  // regionId and skip this (resolver uses regionId first). Nearest-centroid is approximate but
  // cheap and dependency-free — good enough to route a settler the player placed on a region.
  const centroidEntries = Object.entries(centroids);
  const regionAt = (lng, lat) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || centroidEntries.length === 0) return null;
    let best = null;
    let bestD = Infinity;
    for (const [rid, [clng, clat]] of centroidEntries) {
      const d = (clng - lng) ** 2 + (clat - lat) ** 2;
      if (d < bestD) { bestD = d; best = rid; }
    }
    return best;
  };

  // 1. Each AI power moves its settlers/armies and raises new forces per its temperament.
  const planned = planAiTurn({ ownership, units: bundle.world.units || [], adjacency, centroids, behaviors, playerCode, round });

  // 2. The engine finalizes territory: settlements founded, undefended land conquered.
  const resolved = resolveExpansion({ ownership, units: planned.units, adjacency, regionAt });

  // 3. Fold the authoritative result back into the world the LLM will narrate and we will persist.
  bundle.world.regionOwnershipOverrides = resolved.ownership;
  bundle.world.units = resolved.units;

  if (resolved.ownershipChanges.length === 0) return "";

  const nameOf = (code) => bundle.world.polityOverrides?.[code]?.name || code;
  const lines = resolved.ownershipChanges.map((c) =>
    c.kind === "conquest"
      ? `${nameOf(c.to)} conquered the region ${c.regionId} from ${nameOf(c.from)}.`
      : `${nameOf(c.to)} founded a new colony in the region ${c.regionId}.`,
  );
  return `This turn, ${resolved.ownershipChanges.length} territory change(s) occurred and are FINAL. ${lines.join(" ")}`;
};

// Rides along with every turn/GM request as part of the user message — NOT the
// editable prompt pack, so a scenario that bundles its own prompts can't lose
// it. Without this the model routinely narrates conquests in prose while the
// borders stay frozen, or keys transfers on names the map doesn't recognize
// (names DO resolve now — see runtime/regionTransferResolver.js — but only if
// the model actually emits the transfer entries).
const REGION_TRANSFER_CONTRACT =
  "Territory changes on the map ONLY through impacts.regionTransfers — narration alone never moves a border. " +
  "Emit one entry for EVERY region that changes hands: " +
  '{"regionId":"<exact map region id if known, else empty>","regionName":"<the region\'s name>","fromCode":"<current owner code>","toCode":"<new owner code>"}. ' +
  "Region names are resolved to map regions automatically, so an exact name is enough; " +
  "to transfer a polity's entire territory, put the polity or country name in regionName. " +
  "In every human-readable string (summary, event titles and descriptions, chat messages) refer to polities by their " +
  "display names (e.g. \"Germany\"), NEVER by internal codes (e.g. \"GER\") — codes belong only in machine fields " +
  "(regionId, fromCode, toCode, ownerCode, code).";

// Rides the user message alongside REGION_TRANSFER_CONTRACT (same pack-proof
// reason). Ties durable/material events to the persistent ledger so growth
// accumulates instead of being re-hallucinated each turn.
const LEDGER_CONTRACT =
  "Any event that builds, destroys, or reforms something durable (a building, fortress, canal, port, university, " +
  "institution, reform, or wonder) OR materially shifts a nation's condition (an economic boom or collapse, a war " +
  "won or lost, a political upheaval) MUST carry impacts.ledgerChanges. Each entry is " +
  '{"code":"<polity code>","statChanges":{<any of stability, economy, military, technology, prestige as small integer deltas>},' +
  '"addDevelopments":[{"name":"","kind":"building|infrastructure|reform|military|wonder|other","regionName":"","note":""}],' +
  '"removeDevelopments":["<id or exact name of a development that was destroyed>"],"notes":"<short strategic memory, replaces prior notes>"}. ' +
  "The developments already listed in each nation's ledger are GROUND TRUTH and persist across turns until an event " +
  "explicitly removes them — never re-create a development that already exists. Stat deltas are SMALL (typically ±1 to " +
  "±8) and must follow directly from what the event describes; growth is gradual and should compound from existing " +
  "developments rather than leaping.";

// Rides the user message alongside REGION_TRANSFER_CONTRACT. Teaches the model
// the one thing the base game never did: decisively beating a nation ends it and
// hands over ALL of its land in a single whole-polity transfer.
const CONQUEST_CONTRACT =
  "A DECISIVE military victory — an enemy capital taken, its field army destroyed, its government capitulating, or its " +
  "leadership captured — ENDS that nation. When it happens, emit exactly ONE impacts.regionTransfers entry whose " +
  "regionName is the LOSING polity's DISPLAY NAME (the resolver expands it to every region that polity holds) AND one " +
  'impacts.polityChanges entry {"code":"<loser code>","status":"annexed","absorbedBy":"<victor code>"}. ' +
  "A merely PARTIAL victory transfers only the specifically named regions and does NOT annex the polity. Once a polity " +
  "is annexed or collapsed it is defunct: it must never act, speak, negotiate, or appear as an independent actor in any " +
  "later event — its army and government are gone.";

// Stage 2 fans out over the turn's events in batches of this size.
const IMPACT_BATCH_SIZE = 10;
// Stage 1 (one call, up to 30+ narrated events) gets the long budget; each
// Stage 2 batch (≤10 events → impacts only) gets a shorter one.
const STAGE1_TIMEOUT_MS = 300000;
const STAGE2_TIMEOUT_MS = 180000;
const JUMP_STAGE_ATTEMPTS = 2;

// A dense, code-keyed roster of every polity the model might touch, so Stage 2's
// user message names the codes it must use in fromCode/toCode/absorbedBy even if
// a scenario prompt pack shadowed the system prompt's map description.
const buildPolityCodeList = async (world) => {
  const catalog = mergePolityCatalog(await loadCountryNames().catch(() => []), world);
  const byCode = new Map();
  for (const entry of catalog) {
    if (!entry.code) continue;
    const key = entry.code.toUpperCase();
    if (!byCode.has(key)) byCode.set(key, entry.name || entry.code);
  }
  if (byCode.size === 0) return "No polity codes are recorded.";
  return Array.from(byCode.entries())
    .slice(0, 200)
    .map(([code, name]) => `${code} = ${name}`)
    .join("\n");
};

// Stage 2 user message for ONE batch. Carries the impact contracts and the
// machine context (territory with region ids + polity code list) in the user
// message, pack-proof, alongside the batch's globally-numbered events. Impacts
// are keyed back to the whole-turn list by the eventIndex shown here.
const buildImpactsUserMessage = ({ batch, batchStart, territoryOverridesText, polityCodeList }) => {
  const numbered = batch
    .map((event, offset) => {
      const idx = batchStart + offset;
      const date = normalizeString(event?.date) || "undated";
      const title = normalizeString(event?.title);
      const description = normalizeString(event?.description);
      return `Event ${idx}: [${date}] ${title}${description ? `\n  ${description}` : ""}`;
    })
    .join("\n\n");

  return (
    "Encode the machine impacts for the already-written events below. Return JSON only in the shape " +
    '{"impacts":[{"eventIndex":N,...}]}. Use the EXACT eventIndex shown beside each event. Emit an entry ' +
    "ONLY for events with a real, concrete consequence — an empty impacts array is a valid answer for a calm " +
    "batch. Do not invent events or restate their text.\n\n" +
    `EVENTS TO ENCODE:\n${numbered}\n\n` +
    `${REGION_TRANSFER_CONTRACT} ${LEDGER_CONTRACT} ${CONQUEST_CONTRACT}\n\n` +
    `CURRENT TERRITORY OVERRIDES (region name [region id] -> owner code):\n${territoryOverridesText}\n\n` +
    `POLITY CODES (machine code = display name):\n${polityCodeList}`
  );
};

// Pax Colonia's turn simulation, reworked into a FAIL-HARD two-stage pipeline.
// Stage 1 writes the narrative (one call, no impacts). Stage 2 encodes impacts
// for the resulting events in parallel batches. Any unrecoverable failure THROWS
// before applySimulationResult runs, so a failed turn mutates NO game state and
// the UI shows the error — there is no canned fallback turn anymore.
export const simulateTimelineJump = async ({ days, mode = "jump", onProgress } = {}) => {
  const report = (label) => {
    if (typeof onProgress === "function") {
      try {
        onProgress(label);
      } catch {
        // progress reporting is best-effort and must never break a turn
      }
    }
  };

  const bundle = await readGameStateBundle({ force: true });
  const baseColors = await readJson(JSON_URLS.colors, { defaultValue: {}, force: true });
  // Resolve deterministic settlement/conquest first, then let the LLM narrate what already happened.
  const territorySummary = await applyDeterministicExpansion(bundle);
  const safeDays = Math.max(1, Math.trunc(Number(days) || 0));
  // Ancient/FMG scenarios use plain-text or BCE dates dayjs can't parse. Guard
  // the day-math so it doesn't format to the literal string "Invalid Date" and
  // then get persisted into game.gameDate (which corrupted the save and every
  // subsequent date). When unparseable, keep the current date and let the AI's
  // own stopDate drive the narrative forward.
  const parsedGameDate = dayjs(bundle.game.gameDate);
  const targetDate = parsedGameDate.isValid()
    ? parsedGameDate.add(safeDays, "day").format("YYYY-MM-DD")
    : normalizeString(bundle.game.gameDate);
  const variables = await buildTemplateVariables(bundle, { targetDate, deterministicTerritoryChanges: territorySummary });
  const [minEvents, maxEvents] = eventCountRangeForDays(safeDays);

  // ---- Stage 1: narrative only (no impacts). Up to 2 attempts, then throw. ----
  report("Writing the chronicle…");
  const stage1UserMessage =
    (mode === "auto"
      ? "Simulate an auto-jump and stop at the next notable or player-relevant event. Return JSON only. " +
        "Scale the events array to the time actually covered before your stop point: roughly 1-2 events per week, " +
        "5-7 per month, 10-13 per quarter, up to 29-37 for a full year — spread their dates across the covered period."
      : `Simulate a standard jump forward to the requested target date. Return JSON only. The "events" array must ` +
        `contain between ${minEvents} and ${maxEvents} events (this jump covers ${safeDays} days), with their dates ` +
        `spread across the skipped period.`) +
    " Write ONLY the narrative for each event (title, description, date) — do NOT include any impacts, region " +
    "transfers, polity changes, ledger changes, unit operations, or created chats; those consequences are encoded " +
    "in a separate later step, so leave them out here. Still narrate territorial changes, conquests, construction " +
    "and battles inside the descriptions, and make sure the narrative covers and resolves every one of the player's " +
    "planned actions this round." +
    buildContinuitySections(variables);

  const runStage1Attempt = async () => {
    const parsed = await runJsonTask(mode === "auto" ? "autoJumpNarrative" : "jumpNarrative", {
      timeoutMs: STAGE1_TIMEOUT_MS,
      userMessage: stage1UserMessage,
      variables,
    });
    const check = validateNarrativePayload(parsed);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    return parsed;
  };

  let stage1 = null;
  let stage1Reason = "";
  for (let attempt = 1; attempt <= JUMP_STAGE_ATTEMPTS; attempt += 1) {
    try {
      stage1 = await runStage1Attempt();
      break;
    } catch (error) {
      stage1Reason = error?.message || String(error);
      console.warn(`[ai] jump narrative attempt ${attempt}/${JUMP_STAGE_ATTEMPTS} failed: ${stage1Reason}`);
    }
  }
  if (!stage1) {
    throw new Error(
      `The AI simulator failed this turn (narrative: ${stage1Reason || "no usable output"}). ` +
        "Nothing was changed — try the jump again.",
    );
  }

  const events = normalizeArray(stage1.events);

  // ---- Stage 2: impacts per event, in parallel batches. Each batch: 2 tries. ----
  const territoryOverridesText = await buildTerritorySummary(bundle.world);
  const polityCodeList = await buildPolityCodeList(bundle.world);
  const batches = chunkEvents(events, IMPACT_BATCH_SIZE);
  const totalBatches = batches.length;
  let batchesDone = 0;
  report(`Resolving consequences… (batch 0/${totalBatches})`);

  const runBatch = async (batch, batchIndex) => {
    const batchStart = batchIndex * IMPACT_BATCH_SIZE;
    const userMessage = buildImpactsUserMessage({ batch, batchStart, territoryOverridesText, polityCodeList });

    let entries = null;
    let reason = "";
    for (let attempt = 1; attempt <= JUMP_STAGE_ATTEMPTS; attempt += 1) {
      try {
        const parsed = await runJsonTask("jumpImpacts", {
          timeoutMs: STAGE2_TIMEOUT_MS,
          userMessage,
          variables,
        });
        // A parseable reply (even with no impacts) is a success — calm batch.
        entries = normalizeImpactsPayload(parsed, batchStart, batch.length);
        break;
      } catch (error) {
        reason = error?.message || String(error);
        console.warn(
          `[ai] jump impacts batch ${batchIndex + 1}/${totalBatches} attempt ${attempt}/${JUMP_STAGE_ATTEMPTS} failed: ${reason}`,
        );
      }
    }
    if (entries === null) {
      // One failed batch fails the whole turn — no partial or canned impacts.
      throw new Error(
        `The AI simulator failed this turn (impacts batch ${batchIndex + 1}/${totalBatches}: ${reason || "no usable output"}). ` +
          "Nothing was changed — try the jump again.",
      );
    }
    batchesDone += 1;
    report(`Resolving consequences… (batch ${batchesDone}/${totalBatches})`);
    return entries;
  };

  const batchResults = await Promise.all(batches.map((batch, batchIndex) => runBatch(batch, batchIndex)));
  const impactEntries = batchResults.flat();

  // Merge impacts back onto the narrative events by GLOBAL index, then feed the
  // combined result through the unchanged apply path (region resolver + ledger).
  const mergedEvents = mergeImpactsByIndex(events, impactEntries);

  report("Applying the turn…");
  const result = {
    catalyst: stage1?.catalyst ?? null,
    clearActions: stage1?.clearActions !== false,
    events: mergedEvents,
    mode,
    stopDate: normalizeString(stage1?.stopDate) || targetDate,
    summary: normalizeString(stage1?.summary),
  };

  return applySimulationResult({
    baseActions: bundle.actions,
    baseChats: bundle.chats,
    baseColors,
    baseEvents: bundle.events,
    baseGame: bundle.game,
    baseWorld: bundle.world,
    result,
  });
};

export const simulateAutoJump = async ({ days = 365, onProgress } = {}) =>
  simulateTimelineJump({ days, mode: "auto", onProgress });

export const applyGameMasterCommand = async (requestText) => {
  const bundle = await readGameStateBundle({ force: true });
  const baseColors = await readJson(JSON_URLS.colors, { defaultValue: {}, force: true });
  const variables = await buildTemplateVariables(bundle, { gameMasterRequest: requestText });
  // No fallback: the user rejected canned GM changes. A failed generation THROWS
  // before any state is written; the cheats-panel runBusy shows the message.
  let payload;
  try {
    payload = await runJsonTask("gameMaster", {
      userMessage:
        `Apply the GM request as JSON only. ${REGION_TRANSFER_CONTRACT} ${LEDGER_CONTRACT} ${CONQUEST_CONTRACT}` +
        buildContinuitySections(variables),
      variables,
    });
  } catch (error) {
    console.warn(`[ai] game master request failed (${error?.message || error}).`);
    throw new Error("The AI could not process the game master request — nothing was changed. Try again.");
  }

  const gmEvent = normalizeGeneratedEvent({
    date: bundle.game.gameDate,
    description: normalizeString(payload?.summary),
    impacts: payload?.impacts,
    importance: "major",
    kind: "game-master",
    notable: true,
    playerRelated: true,
    title: "Game master intervention",
  });

  if (!gmEvent) {
    throw new Error("The game master request did not produce a valid change set.");
  }

  return applySimulationResult({
    baseActions: bundle.actions,
    baseChats: bundle.chats,
    baseColors,
    baseEvents: bundle.events,
    baseGame: bundle.game,
    baseWorld: bundle.world,
    result: {
      catalyst: null,
      clearActions: false,
      events: [gmEvent],
      mode: "game-master",
      stopDate: bundle.game.gameDate,
      summary: gmEvent.description,
    },
  });
};
