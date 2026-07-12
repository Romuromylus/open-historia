/*! Open Historia — national stats pane © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { readGameData, readWorldState } from "../../runtime/gameState.js";
import { useCountryDisplayName } from "../../runtime/polityNames.js";
import { flagImageUrlFromGid } from "../../runtime/countryFlags.js";
import { setRegionClickObserver } from "../Selection/Regions.jsx";
import { generateCountryStatSheet } from "../AI/gameplay.js";

// Sheets are regenerated when the game date moves; within a date they persist
// across reloads so flipping between countries stays instant.
const STORAGE_KEY = "oh-stat-sheets";
const MAX_STORED_SHEETS = 60;
const memoryCache = new Map();

const readStoredSheets = () => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
        return {};
    }
};

const storeSheet = (key, entry) => {
    try {
        const all = readStoredSheets();
        all[key] = entry;
        const keys = Object.keys(all);
        if (keys.length > MAX_STORED_SHEETS) {
            for (const stale of keys.slice(0, keys.length - MAX_STORED_SHEETS)) delete all[stale];
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
        // Quota errors just mean no persistence — the memory cache still works.
    }
};

const clamp01 = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const INDEX_ROWS = [
    { key: "sovereignty", label: "Sovereignty", icon: "⚑", color: "#8b5cf6" },
    { key: "foodAutonomy", label: "Food autonomy", icon: "🌾", color: "#22c55e" },
    { key: "energyAutonomy", label: "Energy autonomy", icon: "⚡", color: "#eab308" },
    { key: "economicIndependence", label: "Economic independence", icon: "🏦", color: "#06b6d4" },
    { key: "internalSecurity", label: "Internal security", icon: "🛡", color: "#f43f5e" },
];

// Persistent ground-truth ledger stats (world.polityLedgers[code].stats) —
// distinct from the AI-authored sheet above; shown as the "National condition".
const LEDGER_STRIP_ROWS = [
    { key: "stability", label: "Stability", color: "#22c55e" },
    { key: "economy", label: "Economy", color: "#06b6d4" },
    { key: "military", label: "Military", color: "#f43f5e" },
    { key: "technology", label: "Technology", color: "#8b5cf6" },
    { key: "prestige", label: "Prestige", color: "#eab308" },
];

const DEVELOPMENT_KIND_ICONS = {
    building: "🏛",
    infrastructure: "🛤",
    reform: "📜",
    military: "⚔",
    wonder: "✨",
    other: "🔧",
};
const MAX_DEVELOPMENTS_SHOWN = 12;

const sectionTitleStyle = {
    color: "rgba(255,255,255,0.45)",
    fontSize: "0.68rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    margin: "1.1rem 0 0.6rem",
    textTransform: "uppercase",
};

const cardStyle = {
    backgroundColor: "rgba(255,255,255,0.045)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "10px",
    padding: "0.6rem 0.7rem",
};

const Bar = ({ value, color }) => (
    <div style={{ backgroundColor: "rgba(255,255,255,0.1)", borderRadius: "999px", height: "6px", overflow: "hidden" }}>
    <div style={{ backgroundColor: color, borderRadius: "999px", height: "100%", width: `${clamp01(value)}%`, transition: "width 0.4s" }} />
    </div>
);

// Growth arrow vs the previous stored sheet for this country. Hidden when the
// delta is zero or there is no prior sheet to compare against.
const DeltaBadge = ({ delta }) => {
    if (!Number.isFinite(delta) || delta === 0) return null;
    const up = delta > 0;
    return (
        <span data-no-translate style={{ color: up ? "#22c55e" : "#ef4444", fontSize: "0.68rem", fontWeight: 700, marginLeft: "0.35rem" }}>
        {up ? "▲" : "▼"} {up ? "+" : "-"}{Math.abs(delta)}
        </span>
    );
};

const EconomyCard = ({ label, value, sub, tone }) => (
    <div style={cardStyle}>
    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.06em", marginBottom: "0.3rem", textTransform: "uppercase" }}>
    {label}
    </div>
    <div data-no-translate style={{ color: tone, fontSize: "1.05rem", fontWeight: 800 }}>{value || "—"}</div>
    {sub && <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.68rem", marginTop: "0.15rem" }}>{sub}</div>}
    </div>
);

const stabilityColor = (value) => (value < 40 ? "#ef4444" : value < 70 ? "#f59e0b" : "#22c55e");

// The five numbers deltas are computed from. Stored (compactly) with each cache
// entry so the arrows survive cache hits and manual re-rolls within a date.
const extractSheetStats = (sheet) => {
    if (!sheet || typeof sheet !== "object") return null;
    const indices = {};
    for (const row of INDEX_ROWS) indices[row.key] = clamp01(sheet.indices?.[row.key]);
    return { indices, stability: clamp01(sheet.stability) };
};

// The most recent stored sheet for the SAME code with a strictly OLDER date.
// Cache keys are `${gameKey}:${code}`; ISO dates compare lexicographically.
const findPriorSheet = (gameKey, code, currentDate) => {
    try {
        const all = readStoredSheets();
        const upper = String(code).toUpperCase();
        let best = null;
        for (const [key, entry] of Object.entries(all)) {
            if (!entry || typeof entry !== "object" || !entry.sheet) continue;
            const parts = String(key).split(":");
            const keyCode = parts[parts.length - 1];
            const keyGame = parts.slice(0, -1).join(":");
            if (keyGame !== String(gameKey)) continue;
            if (String(keyCode).toUpperCase() !== upper) continue;
            const date = typeof entry.date === "string" ? entry.date : "";
            if (!date || (currentDate && date >= currentDate)) continue;
            if (!best || date > best.date) best = { date, sheet: entry.sheet };
        }
        return best;
    } catch {
        return null;
    }
};

// Case-insensitive lookup into a code-keyed map (ledgers / overrides).
const lookupByCode = (map, code) => {
    if (!map || typeof map !== "object" || !code) return null;
    if (map[code]) return map[code];
    const upper = String(code).toUpperCase();
    if (map[upper]) return map[upper];
    const hit = Object.entries(map).find(([key]) => String(key).toUpperCase() === upper);
    return hit ? hit[1] : null;
};

const StatsPane = ({ active }) => {
    const [player, setPlayer] = useState({ code: "", date: "", gameKey: "game" });
    const [targetCode, setTargetCode] = useState("");
    const [polity, setPolity] = useState(null); // world.polityOverrides[target]
    const [ledger, setLedger] = useState(null); // world.polityLedgers[target]
    const [defunct, setDefunct] = useState(null); // { status, byName } when annexed/collapsed
    const [state, setState] = useState({ status: "idle", sheet: null, error: "", priorStats: null });
    const [flagFailed, setFlagFailed] = useState(false);
    const displayName = useCountryDisplayName(targetCode);

    // Which game and which date are we in? Also seeds the target: your country.
    useEffect(() => {
        if (!active) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const game = await readGameData({ force: true });
                if (cancelled) return;
                const code = String(game?.country || "").trim();
                setPlayer({
                    code,
                    date: String(game?.gameDate || game?.startDate || ""),
                    gameKey: String(game?.id || game?.name || "game"),
                });
                setTargetCode((current) => current || code);
            } catch {
                // Without game data the pane just shows its empty state.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [active]);

    // While the pane is showing, clicking any country on the map inspects it.
    useEffect(() => {
        if (!active) return undefined;
        setRegionClickObserver((props) => {
            const code = String(props?.owner || props?.gid0 || props?.GID_0 || "").trim();
            if (code) setTargetCode(code);
        });
        return () => setRegionClickObserver(null);
    }, [active]);

    const loadSheet = useCallback(async ({ force = false } = {}) => {
        const code = targetCode;
        if (!code) return;
        const cacheKey = `${player.gameKey}:${code}`;
        const existing = memoryCache.get(cacheKey) ?? readStoredSheets()[cacheKey];
        if (!force) {
            if (existing && existing.date === player.date && existing.sheet) {
                memoryCache.set(cacheKey, existing);
                setState({ status: "ready", sheet: existing.sheet, error: "", priorStats: existing.priorStats ?? null });
                return;
            }
        }
        setState({ status: "loading", sheet: null, error: "", priorStats: null });
        try {
            // Anchor evolution to the same code's most recent older sheet. On a
            // manual re-roll within the same date there is no older sheet, so we
            // fall back to the current entry to keep continuity and deltas stable.
            const prior = findPriorSheet(player.gameKey, code, player.date);
            let priorSheet;
            let priorStats = null;
            if (prior) {
                priorSheet = { ...prior.sheet, __date: prior.date };
                priorStats = extractSheetStats(prior.sheet);
            } else if (existing && existing.date === player.date && existing.sheet) {
                priorSheet = { ...existing.sheet, __date: existing.date };
                priorStats = existing.priorStats ?? null;
            }
            const sheet = await generateCountryStatSheet({ code, name: displayName || code, priorSheet });
            const entry = { date: player.date, priorStats, sheet };
            memoryCache.set(cacheKey, entry);
            storeSheet(cacheKey, entry);
            setState((current) =>
                targetCode === code ? { status: "ready", sheet, error: "", priorStats } : current);
        } catch (error) {
            setState((current) =>
                targetCode === code
                    ? { status: "error", sheet: null, error: error?.message || "The stat sheet failed.", priorStats: null }
                    : current);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetCode, player.gameKey, player.date, displayName]);

    useEffect(() => {
        if (!active || !targetCode) return undefined;
        setFlagFailed(false);
        setLedger(null);
        setDefunct(null);
        let cancelled = false;
        readWorldState({ force: false })
            .then((world) => {
                if (cancelled) return;
                const overrides = world?.polityOverrides ?? {};
                const override = lookupByCode(overrides, targetCode);
                setPolity(override ?? null);
                setLedger(lookupByCode(world?.polityLedgers, targetCode));

                const status = override?.status === "annexed" || override?.status === "collapsed" ? override.status : "";
                if (status) {
                    // Defunct nations have no independent stats — banner only, no sheet.
                    let byName = "";
                    if (status === "annexed") {
                        const by = String(override?.absorbedBy || "").trim();
                        byName = lookupByCode(overrides, by)?.name || by;
                    }
                    setDefunct({ byName, status });
                    setState({ status: "idle", sheet: null, error: "", priorStats: null });
                } else {
                    setDefunct(null);
                    loadSheet();
                }
            })
            .catch(() => {
                if (cancelled) return;
                setPolity(null);
                setLedger(null);
                setDefunct(null);
                loadSheet();
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, targetCode, player.date]);

    const sheet = state.sheet;
    const priorStats = state.priorStats;
    const isPlayer = targetCode && targetCode.toUpperCase() === String(player.code).toUpperCase();
    const flagUrl = polity?.flag || flagImageUrlFromGid(targetCode);
    const initials = String(targetCode).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "??";
    const developments = Array.isArray(ledger?.developments) ? ledger.developments : [];

    const breakdown = useMemo(() => {
        const raw = sheet?.gdpBreakdown ?? {};
        const parts = [
            { key: "agriculture", label: "Agriculture", color: "#22c55e", value: clamp01(raw.agriculture) },
            { key: "industry", label: "Industry", color: "#3b82f6", value: clamp01(raw.industry) },
            { key: "services", label: "Services", color: "#8b5cf6", value: clamp01(raw.services) },
        ];
        const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
        return parts.map((part) => ({ ...part, share: (part.value / total) * 100 }));
    }, [sheet]);

    const budgetNegative = String(sheet?.economy?.budgetBalance ?? "").trim().startsWith("-");
    const stabilityValue = clamp01(sheet?.stability);
    const stabilityDelta = sheet && priorStats ? stabilityValue - priorStats.stability : null;

    return (
        <div style={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0 }}>
        <div style={{ flex: 1, overflowY: "auto", padding: "0.9rem 1rem 1.25rem", scrollbarWidth: "none" }}>

        {!targetCode && (
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "0.85rem" }}>
            No active game. Start one to see national statistics.
            </p>
        )}

        {targetCode && (
            <>
            {/* Country header */}
            <div style={{ alignItems: "flex-start", display: "flex", gap: "0.7rem" }}>
            <div style={{ alignItems: "center", backgroundColor: "rgba(59,130,246,0.16)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px", color: "#93c5fd", display: "flex", flexShrink: 0, fontSize: "0.95rem", fontWeight: 800, height: "2.6rem", justifyContent: "center", overflow: "hidden", width: "2.6rem" }}>
            {flagUrl && !flagFailed ? (
                <img
                alt=""
                src={flagUrl}
                onError={() => setFlagFailed(true)}
                style={{ height: "100%", objectFit: "cover", width: "100%" }}
                />
            ) : initials}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ alignItems: "center", display: "flex", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.05rem", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName || targetCode}
            </span>
            {isPlayer && (
                <span style={{ backgroundColor: "rgba(245,158,11,0.18)", border: "1px solid rgba(245,158,11,0.5)", borderRadius: "999px", color: "#fbbf24", flexShrink: 0, fontSize: "0.62rem", fontWeight: 700, padding: "0.14rem 0.5rem" }}>
                Your country
                </span>
            )}
            </div>
            {sheet && (
                <>
                <div style={{ color: "rgba(255,255,255,0.7)", fontSize: "0.76rem", marginTop: "0.15rem" }}>
                {[sheet.capital, sheet.continent].filter(Boolean).join(" · ")}
                </div>
                {sheet.government && (
                    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: "0.72rem", marginTop: "0.1rem" }}>
                    {sheet.government}
                    </div>
                )}
                {sheet.leader && (
                    <div style={{ color: "#fbbf24", fontSize: "0.72rem", marginTop: "0.1rem" }}>
                    Leader: {sheet.leader}
                    </div>
                )}
                </>
            )}
            </div>
            {state.status !== "loading" && !defunct && (
                <button
                onClick={() => loadSheet({ force: true })}
                title="Regenerate this stat sheet"
                style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: "1rem", padding: 0 }}
                >↻</button>
            )}
            </div>

            {/* Defunct nations carry no independent stats: banner instead of a sheet. */}
            {defunct && (
                <div style={{ backgroundColor: "rgba(239,68,68,0.12)", border: "1px solid #ef4444", borderRadius: "10px", color: "#ef4444", fontSize: "0.85rem", fontWeight: 700, marginTop: "1rem", padding: "0.7rem 0.8rem" }}>
                {defunct.status === "annexed" ? `Annexed by ${defunct.byName || "another power"}` : "Collapsed"}
                </div>
            )}

            {state.status === "loading" && (
                <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "0.82rem", marginTop: "1rem" }}>
                Compiling the stat sheet…
                </p>
            )}

            {state.status === "error" && (
                <div style={{ backgroundColor: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "10px", fontSize: "0.8rem", marginTop: "1rem", padding: "0.7rem 0.8rem" }}>
                {state.error}
                <button
                onClick={() => loadSheet({ force: true })}
                style={{ background: "none", border: "none", color: "#93c5fd", cursor: "pointer", display: "block", fontSize: "0.8rem", fontWeight: 700, marginTop: "0.4rem", padding: 0 }}
                >Try again</button>
                </div>
            )}

            {/* National condition — persistent ground-truth ledger stats. */}
            {ledger && !defunct && (
                <>
                <div style={sectionTitleStyle}>🏛 National condition</div>
                <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {LEDGER_STRIP_ROWS.map((row) => {
                    const value = clamp01(ledger.stats?.[row.key]);
                    return (
                        <div key={row.key}>
                        <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                        <span style={{ color: "rgba(255,255,255,0.7)", fontSize: "0.7rem" }}>{row.label}</span>
                        <span data-no-translate style={{ fontSize: "0.72rem", fontWeight: 800 }}>{value}</span>
                        </div>
                        <Bar value={value} color={row.color} />
                        </div>
                    );
                })}
                </div>
                </>
            )}

            {sheet && state.status === "ready" && (
                <>
                {/* National stability */}
                <div style={{ ...cardStyle, marginTop: "1rem" }}>
                <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: "0.45rem" }}>
                <span style={{ color: "rgba(255,255,255,0.55)", fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                ⚠ National stability
                </span>
                <span style={{ alignItems: "center", display: "flex", fontSize: "0.85rem", fontWeight: 800 }}>
                <span data-no-translate>{stabilityValue}/100</span>
                <DeltaBadge delta={stabilityDelta} />
                </span>
                </div>
                <Bar value={sheet.stability} color={stabilityColor(stabilityValue)} />
                </div>

                {/* Strategic indices */}
                <div style={sectionTitleStyle}>⚑ Strategic indices</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
                {INDEX_ROWS.map((row) => {
                    const value = clamp01(sheet.indices?.[row.key]);
                    const delta = priorStats ? value - (priorStats.indices?.[row.key] ?? value) : null;
                    return (
                        <div key={row.key} style={cardStyle}>
                        <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                        <span style={{ color: "rgba(255,255,255,0.8)", fontSize: "0.76rem" }}>
                        {row.icon} {row.label}
                        </span>
                        <span style={{ alignItems: "center", display: "flex", fontSize: "0.78rem", fontWeight: 800 }}>
                        <span data-no-translate>{value}%</span>
                        <DeltaBadge delta={delta} />
                        </span>
                        </div>
                        <Bar value={value} color={row.color} />
                        </div>
                    );
                })}
                </div>

                {/* Economy */}
                <div style={sectionTitleStyle}>📈 Economy</div>
                <div style={{ display: "grid", gap: "0.55rem", gridTemplateColumns: "1fr 1fr" }}>
                <EconomyCard label="GDP" value={sheet.economy?.gdp} sub={sheet.economy?.gdpGrowth} tone="#34d399" />
                <EconomyCard label="GDP/capita" value={sheet.economy?.gdpPerCapita} sub={sheet.economy?.currency} tone="#e5e7eb" />
                <EconomyCard label="Inflation" value={sheet.economy?.inflation} tone="#34d399" />
                <EconomyCard label="Unemployment" value={sheet.economy?.unemployment} tone="#34d399" />
                <EconomyCard label="Public debt" value={sheet.economy?.publicDebt} tone="#34d399" />
                <EconomyCard
                label="Budget balance"
                value={sheet.economy?.budgetBalance}
                sub={budgetNegative ? "Deficit" : "Surplus"}
                tone={budgetNegative ? "#f87171" : "#34d399"}
                />
                </div>

                {/* GDP breakdown */}
                <div style={{ ...cardStyle, marginTop: "0.9rem" }}>
                <div style={{ color: "rgba(255,255,255,0.7)", fontSize: "0.74rem", marginBottom: "0.5rem" }}>
                GDP breakdown
                </div>
                <div style={{ borderRadius: "999px", display: "flex", height: "10px", overflow: "hidden" }}>
                {breakdown.map((part) => (
                    <div key={part.key} style={{ backgroundColor: part.color, width: `${part.share}%` }} />
                ))}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem 0.8rem", marginTop: "0.5rem" }}>
                {breakdown.map((part) => (
                    <span key={part.key} style={{ alignItems: "center", color: "rgba(255,255,255,0.6)", display: "flex", fontSize: "0.68rem", gap: "0.3rem" }}>
                    <span style={{ backgroundColor: part.color, borderRadius: "2px", height: "7px", width: "7px" }} />
                    {part.label} <span data-no-translate>{part.value}%</span>
                    </span>
                ))}
                </div>
                </div>
                </>
            )}

            {/* National developments — durable improvements from the ledger. */}
            {ledger && !defunct && (
                <>
                <div style={sectionTitleStyle}>🏗 National developments</div>
                <div style={cardStyle}>
                {developments.length === 0 ? (
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.72rem" }}>
                    No recorded developments yet.
                    </div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {developments.slice(0, MAX_DEVELOPMENTS_SHOWN).map((dev, index) => {
                        const meta = [dev.regionName, dev.builtDate].filter(Boolean);
                        return (
                            <div key={dev.id || `${dev.name}-${index}`} style={{ display: "flex", gap: "0.5rem" }}>
                            <span style={{ flexShrink: 0, fontSize: "0.9rem" }}>
                            {DEVELOPMENT_KIND_ICONS[dev.kind] || DEVELOPMENT_KIND_ICONS.other}
                            </span>
                            <div style={{ minWidth: 0 }}>
                            <div style={{ color: "rgba(255,255,255,0.85)", fontSize: "0.76rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dev.name}
                            </div>
                            {meta.length > 0 && (
                                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.66rem", marginTop: "0.1rem" }}>
                                {dev.regionName ? <span>{dev.regionName}</span> : null}
                                {dev.regionName && dev.builtDate ? " · " : null}
                                {dev.builtDate ? <span data-no-translate>{dev.builtDate}</span> : null}
                                </div>
                            )}
                            </div>
                            </div>
                        );
                    })}
                    {developments.length > MAX_DEVELOPMENTS_SHOWN && (
                        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.7rem" }}>
                        +{developments.length - MAX_DEVELOPMENTS_SHOWN} more
                        </div>
                    )}
                    </div>
                )}
                </div>
                </>
            )}

            <p style={{ color: "rgba(255,255,255,0.35)", fontSize: "0.7rem", marginTop: "1rem" }}>
            Click any country on the map to inspect it.
            </p>
            </>
        )}
        </div>
        </div>
    );
};

export default StatsPane;
