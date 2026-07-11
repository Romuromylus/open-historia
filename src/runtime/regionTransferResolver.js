/*! Pax Colonia — resolve LLM-authored region transfers onto real map regions.
 *
 * The map keys ownership by region ID (stock GADM GID_1 like "POL.7_1", or a
 * custom map's "reg_*" ids), but the model that writes a turn's events knows
 * regions by NAME — it has no ID catalog in context. Before this resolver,
 * a transfer like {"regionId":"Mazowieckie","toCode":"DEU"} was persisted
 * verbatim: the override keyed a region no map feature has, so the event log
 * narrated the conquest while the map never repainted.
 *
 * This module turns whatever the model said into catalog-true transfers:
 *   - an exact (or case-drifted) region id passes through canonicalized;
 *   - a region NAME (in regionName or regionId) resolves to the catalog region,
 *     disambiguated by fromCode when several countries share the name;
 *   - a COUNTRY/polity name or code expands to every region that polity
 *     currently holds (full annexations: "Poland -> DEU");
 *   - anything unresolvable is dropped and reported, never persisted as a
 *     dead override.
 *
 * Pure and synchronous — the caller supplies the region catalog and current
 * world state — so it is unit-testable without the map runtime.
 */

const normalize = (value) => String(value ?? "").trim();
const fold = (value) => normalize(value).toLowerCase();

// polityOverrides name/alias -> code, so "Soviet Union" or "USSR" resolves to
// the scenario's actual polity code even when the model writes the long name.
const buildPolityCodeLookup = (polityOverrides) => {
  const lookup = new Map();
  for (const polity of Object.values(polityOverrides ?? {})) {
    if (!polity || typeof polity !== "object") continue;
    const code = normalize(polity.code);
    if (!code) continue;
    lookup.set(fold(code), code);
    if (polity.name) lookup.set(fold(polity.name), code);
    for (const alias of Array.isArray(polity.aliases) ? polity.aliases : []) {
      if (alias) lookup.set(fold(alias), code);
    }
  }
  return lookup;
};

// A region's CURRENT owner: the live override when one exists, else the stock
// map's country (GID_0). Custom-map regions without a countryCode fall back to
// "" — they only count as owned via an explicit override.
const currentOwner = (region, ownership) =>
  normalize(ownership?.[region.id] ?? region.countryCode ?? "");

export const resolveRegionTransfers = (
  transfers,
  { regions = [], ownership = {}, polityOverrides = {} } = {},
) => {
  const catalog = Array.isArray(regions) ? regions.filter((region) => region?.id) : [];
  const resolved = [];
  const unresolved = [];
  if (!Array.isArray(transfers) || transfers.length === 0) {
    return { transfers: resolved, unresolved };
  }

  const byId = new Map();
  const byName = new Map();
  const countryCodeByName = new Map();
  for (const region of catalog) {
    byId.set(fold(region.id), region);
    const nameKey = fold(region.name);
    if (nameKey) {
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(region);
    }
    if (region.countryCode) {
      countryCodeByName.set(fold(region.countryCode), normalize(region.countryCode));
      if (region.country) countryCodeByName.set(fold(region.country), normalize(region.countryCode));
    }
  }
  const polityCodes = buildPolityCodeLookup(polityOverrides);

  // The model may write a polity's display name where a code belongs.
  const toPolityCode = (value) => {
    const raw = normalize(value);
    if (!raw) return "";
    return polityCodes.get(fold(raw)) ?? countryCodeByName.get(fold(raw)) ?? raw;
  };

  // "Poland" / "POL" / a polity alias -> the code whose holdings should move.
  const matchWholePolity = (value) => {
    const key = fold(value);
    if (!key) return "";
    return polityCodes.get(key) ?? countryCodeByName.get(key) ?? "";
  };

  const pickByName = (value, fromCode) => {
    const candidates = byName.get(fold(value)) ?? [];
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const from = fold(fromCode);
    if (from) {
      const owned = candidates.find((region) => fold(currentOwner(region, ownership)) === from);
      if (owned) return owned;
      const inCountry = candidates.find((region) => fold(region.countryCode) === from);
      if (inCountry) return inCountry;
    }
    return candidates[0];
  };

  const seen = new Set();
  const push = (region, { fromCode, toCode, note }) => {
    if (seen.has(region.id)) return;
    seen.add(region.id);
    const owner = currentOwner(region, ownership);
    if (owner && fold(owner) === fold(toCode)) return; // already theirs — nothing to move
    resolved.push({
      fromCode: fromCode || owner,
      note: note || "",
      regionId: region.id,
      regionName: region.name || "",
      toCode,
    });
  };

  for (const entry of transfers) {
    if (!entry || typeof entry !== "object") continue;
    const toCode = toPolityCode(entry.toCode);
    if (!toCode) {
      unresolved.push(entry);
      continue;
    }
    const fromCode = toPolityCode(entry.fromCode);
    const idText = normalize(entry.regionId);
    const nameText = normalize(entry.regionName);

    // 1. A real region id (exact or case-drifted) wins outright.
    const idMatch = idText ? byId.get(fold(idText)) : null;
    if (idMatch) {
      push(idMatch, { fromCode, toCode, note: entry.note });
      continue;
    }

    // 2. Resolve by name — regionName first, then the id field treated as a
    //    name (models routinely put the display name in regionId).
    const nameMatch = pickByName(nameText, fromCode) ?? pickByName(idText, fromCode);
    if (nameMatch) {
      push(nameMatch, { fromCode, toCode, note: entry.note });
      continue;
    }

    // 3. A whole country/polity: expand to everything it currently holds.
    const polityCode = matchWholePolity(nameText) || matchWholePolity(idText);
    if (polityCode) {
      const holdings = catalog.filter(
        (region) => fold(currentOwner(region, ownership)) === fold(polityCode),
      );
      if (holdings.length > 0) {
        for (const region of holdings) {
          push(region, { fromCode: polityCode, toCode, note: entry.note });
        }
        continue;
      }
    }

    unresolved.push(entry);
  }

  return { transfers: resolved, unresolved };
};
