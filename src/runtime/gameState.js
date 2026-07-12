/*! Open Historia — portions (troop deployments + era troop types) © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import { JSON_URLS, readJson, writeJson } from "./assets.js";
import { enqueueContentStrings } from "./translator.js";

export const GAME_DEFAULTS = {
  country: "",
  difficulty: "standard",
  gameDate: "",
  language: "English",
  round: 1,
  startDate: "",
};

export const WORLD_DEFAULTS = {
  actionSuggestions: [],
  activeCatalyst: null,
  language: "English",
  lastJumpMode: "",
  lastJumpSummary: "",
  lastJumpTargetDate: "",
  notes: "",
  polityLedgers: {},
  polityOverrides: {},
  regionOwnershipOverrides: {},
  simulationHistory: [],
  simulationRules: "",
  startingTimelineText: "",
  units: [],
};

// Military units that ride along inside world state (world.units[]). Stored here
// so they share every existing read/write/poll/normalize path with no server change.
// "settler" is a non-combat colonist consumed to found a settlement on an adjacent
// neutral region (see src/runtime/expansion.js). Kept last so military-type ordering
// is unchanged for existing scenarios.
export const UNIT_TYPES = ["infantry", "armor", "air", "naval", "artillery", "garrison", "settler"];
const UNIT_TYPE_SET = new Set(UNIT_TYPES);
// "pending" = a player deployment awaiting AI resolution (rendered translucent).
const UNIT_STATUS_SET = new Set(["idle", "moving", "engaged", "defeated", "pending"]);
const UNIT_SOURCE_SET = new Set(["player", "ai", "scenario"]);

// Persistent national ledger (world.polityLedgers[code]). Stats are integers
// 0-100 (default 50); developments are durable improvements that live until an
// event removes them; notes is short freeform strategic memory. This is the
// anchor that stops the AI re-hallucinating a country's economy every turn.
export const LEDGER_STAT_KEYS = ["stability", "economy", "military", "technology", "prestige"];
const LEDGER_STAT_KEY_SET = new Set(LEDGER_STAT_KEYS);
export const DEVELOPMENT_KINDS = ["building", "infrastructure", "reform", "military", "wonder", "other"];
const DEVELOPMENT_KIND_SET = new Set(DEVELOPMENT_KINDS);
// A polity that is not "active" is DEFUNCT (annexed/collapsed): it no longer
// acts and its ledger stops being shown.
export const POLITY_STATUSES = ["active", "annexed", "collapsed"];
const POLITY_STATUS_SET = new Set(POLITY_STATUSES);

const finiteOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

export const clampUnitStrength = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 100;
  return Math.max(0, Math.min(1000, Math.round(num)));
};

const cloneValue = (value) => {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
};

const normalizeString = (value) => String(value ?? "").trim();

const normalizeOptionalString = (value) => {
  const nextValue = normalizeString(value);
  return nextValue || "";
};

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const normalizeTextLike = (value) => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeOptionalString(value);
  }

  if (value && typeof value === "object") {
    return normalizeOptionalString(
      value.text ??
        value.title ??
        value.label ??
        value.name ??
        value.summary ??
        value.description ??
        value.content ??
        value.result,
    );
  }

  return "";
};

const generateId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

const normalizeActionParticipants = (value) =>
  normalizeArray(value)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);

const clampStat = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
};

const normalizeLedgerStats = (value) => {
  const source = value && typeof value === "object" ? value : {};
  const stats = {};
  for (const key of LEDGER_STAT_KEYS) {
    stats[key] = clampStat(source[key]);
  }
  return stats;
};

// One durable improvement. Name is required (an unnamed development is dropped);
// kind is coerced into DEVELOPMENT_KINDS with an "other" fallback; id/builtDate
// stay as given here (a bare id is filled in by the caller when it needs one).
const normalizeDevelopment = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const name = normalizeOptionalString(entry.name || entry.title || entry.label);
  if (!name) {
    return null;
  }

  const kind = normalizeString(entry.kind || entry.type).toLowerCase();

  return {
    builtDate: normalizeOptionalString(entry.builtDate || entry.date),
    id: normalizeOptionalString(entry.id),
    kind: DEVELOPMENT_KIND_SET.has(kind) ? kind : "other",
    name,
    note: normalizeOptionalString(entry.note),
    regionName: normalizeOptionalString(entry.regionName || entry.region),
  };
};

const normalizePolityStatus = (value, fallback) => {
  const status = normalizeString(value).toLowerCase();
  return POLITY_STATUS_SET.has(status) ? status : fallback;
};

const normalizePolityLedger = (key, value) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const code = normalizeOptionalString(value.code) || normalizeOptionalString(key);
  if (!code) {
    return null;
  }

  return {
    code,
    developments: normalizeArray(value.developments)
      .map((entry) => normalizeDevelopment(entry))
      .filter(Boolean)
      // Stored developments always carry a stable id (referenced by removeDevelopments).
      .map((dev) => ({ ...dev, id: dev.id || generateId("dev") })),
    notes: normalizeOptionalString(value.notes),
    stats: normalizeLedgerStats(value.stats),
    updatedDate: normalizeOptionalString(value.updatedDate),
  };
};

// impacts.ledgerChanges[]: one AI-authored mutation to a country's ledger.
// statChanges are DELTAS (result clamped at apply time) for the 5 known stats
// only; addDevelopments are appended (id/builtDate assigned at apply time);
// removeDevelopments match by id OR case-insensitive name; notes REPLACES.
// A change with no code, or nothing effective to apply, normalizes to null.
const normalizeLedgerChange = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const code = normalizeOptionalString(entry.code || entry.id || entry.polityCode);
  if (!code) {
    return null;
  }

  const statChanges = {};
  const rawStats = entry.statChanges && typeof entry.statChanges === "object" ? entry.statChanges : {};
  for (const key of LEDGER_STAT_KEYS) {
    const delta = Number(rawStats[key]);
    // A zero delta is not a change; unknown stat keys are never read.
    if (Number.isFinite(delta) && delta !== 0) {
      statChanges[key] = delta;
    }
  }

  const addDevelopments = normalizeArray(entry.addDevelopments)
    .map((dev) => normalizeDevelopment(dev))
    .filter(Boolean);
  const removeDevelopments = normalizeArray(entry.removeDevelopments)
    .map((token) => normalizeString(token))
    .filter(Boolean);
  const notes = normalizeOptionalString(entry.notes);

  const hasChange =
    Object.keys(statChanges).length > 0 ||
    addDevelopments.length > 0 ||
    removeDevelopments.length > 0 ||
    notes !== "";
  if (!hasChange) {
    return null;
  }

  return { addDevelopments, code, notes, removeDevelopments, statChanges };
};

const createPolityLedger = (code, date) => ({
  code,
  developments: [],
  notes: "",
  stats: normalizeLedgerStats(null),
  updatedDate: date || "",
});

// Apply one normalized ledgerChange to a polityLedgers map (mutates in place).
// The ledger is created lazily the first time its code is touched.
const applyLedgerChangeToLedgers = (polityLedgers, change, eventDate) => {
  if (!change || !change.code) {
    return;
  }

  const date = normalizeOptionalString(eventDate);
  let ledger = polityLedgers[change.code];
  if (!ledger || typeof ledger !== "object") {
    ledger = createPolityLedger(change.code, date);
    polityLedgers[change.code] = ledger;
  }

  for (const [key, delta] of Object.entries(change.statChanges ?? {})) {
    if (!LEDGER_STAT_KEY_SET.has(key)) continue;
    ledger.stats[key] = clampStat((ledger.stats[key] ?? 50) + delta);
  }

  for (const dev of normalizeArray(change.addDevelopments)) {
    ledger.developments.push({
      ...dev,
      builtDate: dev.builtDate || date,
      id: dev.id || generateId("dev"),
    });
  }

  if (change.removeDevelopments?.length) {
    const tokens = new Set(
      change.removeDevelopments.map((token) => normalizeString(token).toLowerCase()).filter(Boolean),
    );
    if (tokens.size > 0) {
      ledger.developments = ledger.developments.filter(
        (dev) =>
          !tokens.has(normalizeString(dev.id).toLowerCase()) &&
          !tokens.has(normalizeString(dev.name).toLowerCase()),
      );
    }
  }

  if (change.notes) {
    ledger.notes = change.notes;
  }

  ledger.updatedDate = date || ledger.updatedDate;
};

// Compact plain-text block for one polity's ledger (used by the AI world
// summary). Returns "" for a null/empty ledger.
export const summarizePolityLedger = (ledger, { maxDevelopments = 30 } = {}) => {
  if (!ledger || typeof ledger !== "object") {
    return "";
  }

  const code = normalizeOptionalString(ledger.code);
  const stats = normalizeLedgerStats(ledger.stats);
  const developments = normalizeArray(ledger.developments)
    .map((entry) => normalizeDevelopment(entry))
    .filter(Boolean);
  const notes = normalizeOptionalString(ledger.notes);

  if (!code && developments.length === 0 && notes === "") {
    return "";
  }

  const lines = [LEDGER_STAT_KEYS.map((key) => `${key} ${stats[key]}`).join(" · ")];

  const cap = Math.max(0, maxDevelopments);
  const shown = developments.slice(0, cap);
  for (const dev of shown) {
    const meta = [dev.kind];
    if (dev.builtDate) meta.push(`built ${dev.builtDate}`);
    let line = `- ${dev.name} (${meta.join(", ")})`;
    if (dev.note) line += ` — ${dev.note}`;
    lines.push(line);
  }
  if (developments.length > shown.length) {
    lines.push(`…and ${developments.length - shown.length} more`);
  }

  if (notes) {
    lines.push(`Notes: ${notes}`);
  }

  return lines.join("\n");
};

export const normalizeActionEntry = (entry, index = 0) => {
  if (typeof entry === "string") {
    const text = normalizeString(entry);
    if (!text) return null;

    return {
      createdAt: new Date().toISOString(),
      id: generateId(`action-${index}`),
      kind: "action",
      participants: [],
      rawInput: text,
      source: "manual",
      status: "planned",
      text,
      title: text.length > 64 ? `${text.slice(0, 61)}...` : text,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const rawInput = normalizeTextLike(entry.rawInput || entry.input || entry.text || entry.content);
  const text = normalizeTextLike(entry.text || entry.content || entry.body || rawInput);
  const title =
    normalizeTextLike(entry.title || entry.name) ||
    (text.length > 64 ? `${text.slice(0, 61)}...` : text);

  if (!title && !text && !rawInput) {
    return null;
  }

  const kind =
    normalizeString(entry.kind || entry.type).toLowerCase() === "chat"
      ? "chat"
      : "action";

  return {
    chatStarter: normalizeOptionalString(entry.chatStarter || entry.openingMessage),
    createdAt: normalizeOptionalString(entry.createdAt) || new Date().toISOString(),
    id: normalizeOptionalString(entry.id) || generateId(`action-${index}`),
    invitees: normalizeActionParticipants(entry.invitees),
    kind,
    participants: normalizeActionParticipants(entry.participants),
    rawInput: rawInput || text || title,
    source: normalizeOptionalString(entry.source) || "manual",
    status: normalizeOptionalString(entry.status) || "planned",
    suggestionTopic: normalizeOptionalString(entry.suggestionTopic || entry.topic),
    text: text || rawInput || title,
    title: title || rawInput || text,
  };
};

export const normalizeActions = (actions) =>
  normalizeArray(actions)
    .map((entry, index) => normalizeActionEntry(entry, index))
    .filter(Boolean);

const normalizeCatalystChoice = (entry, index = 0) => {
  if (typeof entry === "string") {
    const text = normalizeString(entry);
    if (!text) {
      return null;
    }

    return {
      id: generateId(`catalyst-choice-${index}`),
      result: "",
      text,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const text = normalizeTextLike(entry.text || entry.title || entry.label || entry.name);
  if (!text) {
    return null;
  }

  return {
    ...cloneValue(entry),
    id: normalizeOptionalString(entry.id) || generateId(`catalyst-choice-${index}`),
    result: normalizeTextLike(entry.result || entry.summary || entry.outcome || entry.effect || entry.description),
    text,
  };
};

const normalizeCatalystHistoryEntry = (entry, index = 0) => {
  if (typeof entry === "string") {
    const summary = normalizeString(entry);
    if (!summary) {
      return null;
    }

    return {
      choice: `Step ${index + 1}`,
      summary,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const choice = normalizeTextLike(entry.choice || entry.text || entry.title || entry.name);
  const summary = normalizeTextLike(entry.summary || entry.result || entry.outcome || entry.description);

  if (!choice && !summary) {
    return null;
  }

  return {
    ...cloneValue(entry),
    choice: choice || `Step ${index + 1}`,
    summary,
  };
};

const normalizeCatalyst = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const title = normalizeTextLike(value.title || value.name);
  const premise = normalizeTextLike(value.premise || value.summary || value.description);
  const opening = normalizeTextLike(value.opening || value.text || premise);
  const choices = normalizeArray(value.choices)
    .map((entry, index) => normalizeCatalystChoice(entry, index))
    .filter(Boolean);
  const history = normalizeArray(value.history)
    .map((entry, index) => normalizeCatalystHistoryEntry(entry, index))
    .filter(Boolean);

  if (!title && !premise && !opening && choices.length === 0 && history.length === 0) {
    return null;
  }

  return {
    ...cloneValue(value),
    choices,
    history,
    opening,
    premise,
    title,
  };
};

const normalizeReactionMap = (value) => {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([name, reaction]) => {
        if (!reaction || typeof reaction !== "object") {
          return [name, null];
        }

        const emoji = normalizeOptionalString(reaction.emoji);
        const code = normalizeOptionalString(reaction.code);

        if (!emoji && !code) {
          return [name, null];
        }

        return [
          name,
          {
            ...(code ? { code } : {}),
            ...(emoji ? { emoji } : {}),
          },
        ];
      })
      .filter(([, reaction]) => reaction),
  );
};

const normalizeChatMessage = (message, index = 0) => {
  if (typeof message === "string") {
    const text = normalizeString(message);
    if (!text) return null;

    return {
      code: "",
      id: generateId(`message-${index}`),
      reactions: {},
      role: "system",
      speaker: "",
      text,
      time: "",
    };
  }

  if (!message || typeof message !== "object") {
    return null;
  }

  const text = normalizeOptionalString(message.text || message.message || message.content);
  if (!text) {
    return null;
  }

  return {
    code: normalizeOptionalString(message.code),
    id: normalizeOptionalString(message.id) || generateId(`message-${index}`),
    reactions: normalizeReactionMap(message.reactions),
    role: normalizeOptionalString(message.role || message.sender) || "system",
    speaker: normalizeOptionalString(message.speaker || message.senderName),
    text,
    time: normalizeOptionalString(message.time || message.date),
  };
};

const normalizeChatCountry = (entry) => {
  if (!entry) {
    return null;
  }

  if (typeof entry === "string") {
    const name = normalizeString(entry);
    if (!name) return null;

    return {
      code: "",
      name,
    };
  }

  if (typeof entry !== "object") {
    return null;
  }

  const name = normalizeOptionalString(entry.name || entry.label || entry.country);
  const code = normalizeOptionalString(entry.code || entry.id);

  if (!name && !code) {
    return null;
  }

  return {
    code,
    name: name || code,
  };
};

export const normalizeChatEntry = (entry, index = 0) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const countries = normalizeArray(entry.countries || entry.participants)
    .map((country) => normalizeChatCountry(country))
    .filter(Boolean);

  return {
    countries,
    id: normalizeOptionalString(entry.id) || generateId(`chat-${index}`),
    linkedEventId: normalizeOptionalString(entry.linkedEventId || entry.eventId),
    messages: normalizeArray(entry.messages)
      .map((message, messageIndex) => normalizeChatMessage(message, messageIndex))
      .filter(Boolean),
    source: normalizeOptionalString(entry.source) || "manual",
    status: normalizeOptionalString(entry.status) || "open",
    title: normalizeOptionalString(entry.title),
  };
};

export const normalizeChats = (chats) =>
  normalizeArray(chats)
    .map((entry, index) => normalizeChatEntry(entry, index))
    .filter(Boolean);

const normalizeRegionTransfer = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const regionId = normalizeOptionalString(entry.regionId || entry.id || entry.gid || entry.GID_1);
  const regionName = normalizeOptionalString(entry.regionName || entry.name);
  const toCode = normalizeOptionalString(entry.toCode || entry.toPolity || entry.ownerCode || entry.owner);
  const fromCode = normalizeOptionalString(entry.fromCode || entry.fromPolity);

  // A name-only transfer is kept: the AI usually knows regions by NAME, not map
  // id, and the simulation resolves names to real region ids before applying
  // (see runtime/regionTransferResolver.js). Only a transfer with no target at
  // all, or nothing identifying the territory, is dropped.
  if ((!regionId && !regionName) || !toCode) {
    return null;
  }

  return {
    fromCode,
    note: normalizeOptionalString(entry.note || entry.reason),
    regionId,
    regionName,
    toCode,
  };
};

const normalizePolityChange = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const code = normalizeOptionalString(entry.code || entry.id || entry.polityCode);
  if (!code) {
    return null;
  }

  return {
    absorbedBy: normalizeOptionalString(entry.absorbedBy),
    aliases: normalizeActionParticipants(entry.aliases || entry.additionalNames),
    code,
    color: normalizeOptionalString(entry.color),
    name: normalizeOptionalString(entry.name || entry.newName),
    note: normalizeOptionalString(entry.note || entry.reason),
    // "" means "no change" — only a valid status flips a polity's lifecycle.
    status: normalizePolityStatus(entry.status, ""),
  };
};

export const normalizeUnitEntry = (entry, index = 0) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const lng = finiteOrNull(entry.lng ?? entry.lon ?? entry.longitude);
  const lat = finiteOrNull(entry.lat ?? entry.latitude);
  const ownerCode = normalizeOptionalString(entry.ownerCode || entry.owner || entry.code);
  if (lng === null || lat === null || !ownerCode) {
    return null;
  }

  const type = normalizeOptionalString(entry.type).toLowerCase();
  const status = normalizeOptionalString(entry.status).toLowerCase();
  const source = normalizeOptionalString(entry.source).toLowerCase();
  const timestamp = new Date().toISOString();

  return {
    id: normalizeOptionalString(entry.id) || generateId(`unit-${index}`),
    name: normalizeOptionalString(entry.name) || "Unit",
    type: UNIT_TYPE_SET.has(type) ? type : "infantry",
    ownerCode,
    strength: clampUnitStrength(entry.strength ?? 100),
    lng,
    lat,
    regionId: normalizeOptionalString(entry.regionId),
    status: UNIT_STATUS_SET.has(status) ? status : "idle",
    note: normalizeOptionalString(entry.note),
    source: UNIT_SOURCE_SET.has(source) ? source : "scenario",
    orderId: normalizeOptionalString(entry.orderId),
    createdAt: normalizeOptionalString(entry.createdAt) || timestamp,
    updatedAt: normalizeOptionalString(entry.updatedAt) || timestamp,
  };
};

export const normalizeUnits = (units) =>
  normalizeArray(units)
    .map((entry, index) => normalizeUnitEntry(entry, index))
    .filter(Boolean);

// One AI-authored mutation to the unit list: spawn | move | strength | remove.
const normalizeUnitOp = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const op = normalizeOptionalString(entry.op).toLowerCase();
  const unitId = normalizeOptionalString(entry.unitId || entry.id);

  if (op === "spawn") {
    const unit = normalizeUnitEntry(entry.unit ?? entry, 0);
    if (!unit) return null;
    unit.source = "ai";
    return { op, unit };
  }

  if (!unitId) {
    return null;
  }

  if (op === "move") {
    const toLng = finiteOrNull(entry.toLng ?? entry.lng);
    const toLat = finiteOrNull(entry.toLat ?? entry.lat);
    if (toLng === null || toLat === null) return null;
    return {
      op,
      unitId,
      toLng,
      toLat,
      regionId: normalizeOptionalString(entry.regionId),
      note: normalizeOptionalString(entry.note),
    };
  }

  if (op === "strength") {
    return { op, unitId, strength: clampUnitStrength(entry.strength ?? 0), note: normalizeOptionalString(entry.note) };
  }

  if (op === "remove") {
    return { op, unitId, note: normalizeOptionalString(entry.note) };
  }

  return null;
};

// Apply a batch of unit ops to a unit list (pure). Ops referencing unknown ids
// are silently ignored; units reduced to <=0 strength are dropped.
export const applyUnitOps = (units, ops) => {
  let next = normalizeUnits(units);
  for (const op of normalizeArray(ops)) {
    if (op.op === "spawn") {
      next.push(op.unit);
    } else if (op.op === "move") {
      next = next.map((unit) =>
        unit.id === op.unitId
          ? {
              ...unit,
              lng: op.toLng,
              lat: op.toLat,
              regionId: op.regionId || unit.regionId,
              status: "moving",
              updatedAt: new Date().toISOString(),
            }
          : unit,
      );
    } else if (op.op === "strength") {
      next = next.map((unit) =>
        unit.id === op.unitId
          ? { ...unit, strength: op.strength, status: op.strength <= 0 ? "defeated" : unit.status, updatedAt: new Date().toISOString() }
          : unit,
      );
    } else if (op.op === "remove") {
      next = next.filter((unit) => unit.id !== op.unitId);
    }
  }
  return next.filter((unit) => unit.strength > 0 && unit.status !== "defeated");
};

const normalizeEventImpacts = (value) => {
  if (!value || typeof value !== "object") {
    return {
      actionIds: [],
      createdChats: [],
      ledgerChanges: [],
      polityChanges: [],
      regionTransfers: [],
      unitOps: [],
    };
  }

  return {
    actionIds: normalizeActionParticipants(value.actionIds),
    createdChats: normalizeChats(value.createdChats),
    ledgerChanges: normalizeArray(value.ledgerChanges).map(normalizeLedgerChange).filter(Boolean),
    polityChanges: normalizeArray(value.polityChanges).map(normalizePolityChange).filter(Boolean),
    regionTransfers: normalizeArray(value.regionTransfers).map(normalizeRegionTransfer).filter(Boolean),
    unitOps: normalizeArray(value.unitOps).map(normalizeUnitOp).filter(Boolean),
  };
};

export const normalizeEventEntry = (entry, index = 0) => {
  if (typeof entry === "string") {
    const title = normalizeString(entry);
    if (!title) return null;

    return {
      createdAt: new Date().toISOString(),
      date: "",
      description: "",
      id: generateId(`event-${index}`),
      impacts: normalizeEventImpacts(null),
      importance: "minor",
      kind: "world",
      notable: false,
      playerRelated: false,
      title,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const title =
    normalizeOptionalString(entry.title || entry.headline || entry.name) ||
    normalizeOptionalString(entry.description || entry.summary);

  if (!title) {
    return null;
  }

  return {
    createdAt: normalizeOptionalString(entry.createdAt) || new Date().toISOString(),
    date: normalizeOptionalString(entry.date),
    description: normalizeOptionalString(entry.description || entry.summary || entry.text),
    id: normalizeOptionalString(entry.id) || generateId(`event-${index}`),
    impacts: normalizeEventImpacts(entry.impacts),
    importance: normalizeOptionalString(entry.importance) || "minor",
    kind: normalizeOptionalString(entry.kind) || "world",
    notable: Boolean(entry.notable),
    playerRelated: Boolean(entry.playerRelated),
    title,
  };
};

export const normalizeEvents = (events) => {
  if (Array.isArray(events)) {
    return events
      .map((entry, index) => normalizeEventEntry(entry, index))
      .filter(Boolean);
  }

  if (events && typeof events === "object") {
    if (Array.isArray(events.events)) {
      return normalizeEvents(events.events);
    }

    return Object.values(events)
      .map((entry, index) => normalizeEventEntry(entry, index))
      .filter(Boolean);
  }

  return [];
};

const normalizePolityOverride = (key, value) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const code = normalizeOptionalString(value.code) || normalizeOptionalString(key);
  if (!code) {
    return null;
  }

  return {
    absorbedBy: normalizeOptionalString(value.absorbedBy),
    aliases: normalizeActionParticipants(value.aliases || value.additionalNames),
    code,
    color: normalizeOptionalString(value.color),
    name: normalizeOptionalString(value.name || value.label),
    note: normalizeOptionalString(value.note),
    // Stored polities default to active; a defunct one keeps its recorded status.
    status: normalizePolityStatus(value.status, "active"),
  };
};

const normalizeActionSuggestions = (value) =>
  normalizeArray(value).map((topic) => {
    if (!topic || typeof topic !== "object") {
      return null;
    }

    const title = normalizeOptionalString(topic.title || topic.name);
    if (!title) {
      return null;
    }

    return {
      actions: normalizeArray(topic.actions).map((entry, index) => normalizeActionEntry(entry, index)).filter(Boolean),
      description: normalizeOptionalString(topic.description),
      id: normalizeOptionalString(topic.id) || generateId("topic"),
      title,
    };
  }).filter(Boolean);

export const normalizeWorldState = (world) => {
  const nextWorld = world && typeof world === "object" ? world : {};
  const polityOverrides = Object.fromEntries(
    Object.entries(nextWorld.polityOverrides ?? {})
      .map(([key, value]) => [key, normalizePolityOverride(key, value)])
      .filter(([, value]) => value),
  );

  const regionOwnershipOverrides = Object.fromEntries(
    Object.entries(nextWorld.regionOwnershipOverrides ?? {})
      .map(([regionId, ownerCode]) => [normalizeOptionalString(regionId), normalizeOptionalString(ownerCode)])
      .filter(([regionId, ownerCode]) => regionId && ownerCode),
  );

  // Re-key by the ledger's own code (the source key is only a fallback), so junk
  // keys/entries drop and a ledger is always addressable at world.polityLedgers[code].
  const polityLedgers = {};
  for (const [key, value] of Object.entries(nextWorld.polityLedgers ?? {})) {
    const ledger = normalizePolityLedger(key, value);
    if (ledger) {
      polityLedgers[ledger.code] = ledger;
    }
  }

  return {
    ...WORLD_DEFAULTS,
    ...nextWorld,
    actionSuggestions: normalizeActionSuggestions(nextWorld.actionSuggestions),
    activeCatalyst: normalizeCatalyst(nextWorld.activeCatalyst),
    language: normalizeOptionalString(nextWorld.language) || WORLD_DEFAULTS.language,
    lastJumpMode: normalizeOptionalString(nextWorld.lastJumpMode),
    lastJumpSummary: normalizeOptionalString(nextWorld.lastJumpSummary),
    lastJumpTargetDate: normalizeOptionalString(nextWorld.lastJumpTargetDate),
    notes: normalizeOptionalString(nextWorld.notes),
    polityLedgers,
    polityOverrides,
    regionOwnershipOverrides,
    simulationHistory: normalizeArray(nextWorld.simulationHistory)
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        return {
          ...cloneValue(entry),
          catalyst: normalizeCatalyst(entry.catalyst),
          date: normalizeOptionalString(entry.date),
          eventIds: normalizeActionParticipants(entry.eventIds),
          fromDate: normalizeOptionalString(entry.fromDate || entry.startDate),
          mode: normalizeOptionalString(entry.mode),
          plannedActions: normalizeActions(entry.plannedActions || entry.actions),
          round:
            Number.isFinite(Number(entry.round)) && Number(entry.round) > 0
              ? Math.trunc(Number(entry.round))
              : 0,
          summary: normalizeTextLike(entry.summary),
          toDate: normalizeOptionalString(entry.toDate || entry.endDate || entry.date),
        };
      })
      .filter(Boolean),
    simulationRules: normalizeOptionalString(nextWorld.simulationRules),
    startingTimelineText: normalizeOptionalString(nextWorld.startingTimelineText),
    units: normalizeUnits(nextWorld.units),
  };
};

export const normalizeGameData = (game) => {
  const nextGame = game && typeof game === "object" ? game : {};

  return {
    ...GAME_DEFAULTS,
    ...nextGame,
    country: normalizeOptionalString(nextGame.country),
    difficulty: normalizeOptionalString(nextGame.difficulty) || GAME_DEFAULTS.difficulty,
    gameDate: normalizeOptionalString(nextGame.gameDate),
    language: normalizeOptionalString(nextGame.language) || GAME_DEFAULTS.language,
    round:
      Number.isFinite(Number(nextGame.round)) && Number(nextGame.round) > 0
        ? Math.trunc(Number(nextGame.round))
        : GAME_DEFAULTS.round,
    startDate: normalizeOptionalString(nextGame.startDate),
  };
};

export const buildActionDisplayText = (action) => {
  const normalized = normalizeActionEntry(action);
  if (!normalized) {
    return "";
  }

  return normalized.kind === "chat" && normalized.chatStarter
    ? `${normalized.title}: ${normalized.chatStarter}`
    : normalized.text;
};

export const readWorldState = async ({ force = false } = {}) =>
  normalizeWorldState(await readJson(JSON_URLS.world, { defaultValue: WORLD_DEFAULTS, force }));

export const writeWorldState = async (world, options = {}) => {
  const normalized = normalizeWorldState(world);
  // Edited/AI-written polity names, aliases and notes get translated (and
  // saved to the server language pack) the moment they're written, not when
  // they first happen to be rendered somewhere.
  enqueueContentStrings(normalized.polityOverrides);
  return writeJson(JSON_URLS.world, normalized, { pretty: true, ...options });
};

export const readGameData = async ({ force = false } = {}) =>
  normalizeGameData(await readJson(JSON_URLS.game, { defaultValue: GAME_DEFAULTS, force }));

export const writeGameData = async (game, options = {}) =>
  writeJson(JSON_URLS.game, normalizeGameData(game), { pretty: true, ...options });

export const readActionsState = async ({ force = false } = {}) =>
  normalizeActions(await readJson(JSON_URLS.actions, { defaultValue: [], force }));

export const writeActionsState = async (actions, options = {}) =>
  writeJson(JSON_URLS.actions, normalizeActions(actions), { pretty: true, ...options });

export const readEventsState = async ({ force = false } = {}) =>
  normalizeEvents(await readJson(JSON_URLS.events, { defaultValue: [], force }));

export const writeEventsState = async (events, options = {}) => {
  const normalized = normalizeEvents(events);
  // New/edited event text follows the UI language immediately (see above).
  enqueueContentStrings(normalized);
  return writeJson(JSON_URLS.events, normalized, { pretty: true, ...options });
};

export const readChatsState = async ({ force = false } = {}) =>
  normalizeChats(await readJson(JSON_URLS.chat, { defaultValue: [], force }));

export const writeChatsState = async (chats, options = {}) =>
  writeJson(JSON_URLS.chat, normalizeChats(chats), { pretty: true, ...options });

export const readGameStateBundle = async ({ force = false } = {}) => {
  const [actions, chats, events, game, world] = await Promise.all([
    readActionsState({ force }),
    readChatsState({ force }),
    readEventsState({ force }),
    readGameData({ force }),
    readWorldState({ force }),
  ]);

  return {
    actions,
    chats,
    events,
    game,
    world,
  };
};

export const applyEventImpactsToWorld = ({ colors = {}, events = [], world }) => {
  const nextColors = cloneValue(colors) ?? {};
  const nextWorld = normalizeWorldState(world);

  for (const event of normalizeEvents(events)) {
    for (const transfer of event.impacts.regionTransfers) {
      // Name-only transfers (no resolved region id) never become overrides — an
      // empty/unresolved key would silently color nothing on the map.
      if (!transfer.regionId) continue;
      nextWorld.regionOwnershipOverrides[transfer.regionId] = transfer.toCode;
    }

    for (const change of event.impacts.polityChanges) {
      nextWorld.polityOverrides[change.code] = {
        ...(nextWorld.polityOverrides[change.code] ?? {
          absorbedBy: "",
          aliases: [],
          code: change.code,
          color: "",
          name: "",
          note: "",
          status: "active",
        }),
        ...(change.aliases?.length > 0 ? { aliases: change.aliases } : {}),
        ...(change.color ? { color: change.color } : {}),
        ...(change.name ? { name: change.name } : {}),
        ...(change.note ? { note: change.note } : {}),
        // status "" from a change means "leave lifecycle unchanged".
        ...(change.status ? { status: change.status } : {}),
        ...(change.absorbedBy ? { absorbedBy: change.absorbedBy } : {}),
      };

      if (change.color) {
        const normalizedColor = normalizeOptionalString(change.color);
        const hexMatch = /^#?([a-f0-9]{6})$/i.exec(normalizedColor);
        if (hexMatch) {
          const hex = hexMatch[1];
          nextColors[change.code] = [
            Number.parseInt(hex.slice(0, 2), 16),
            Number.parseInt(hex.slice(2, 4), 16),
            Number.parseInt(hex.slice(4, 6), 16),
          ];
        }
      }
    }

    if (event.impacts.unitOps?.length) {
      nextWorld.units = applyUnitOps(nextWorld.units, event.impacts.unitOps);
    }

    for (const change of event.impacts.ledgerChanges) {
      applyLedgerChangeToLedgers(nextWorld.polityLedgers, change, event.date);
    }
  }

  return {
    colors: nextColors,
    world: nextWorld,
  };
};
