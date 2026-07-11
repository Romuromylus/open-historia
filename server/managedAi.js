/*! Pax Colonia — server-baked LLM endpoint.
 *
 * A stock Open Historia install makes every player paste their own provider
 * endpoint + API key into Settings. For a hosted deployment that is a chore and
 * a leak: the operator wants ONE endpoint used by everyone, with the key kept on
 * the server rather than shipped to every browser.
 *
 * When the operator sets LLM_BASE_URL + LLM_API_KEY (and, ideally, LLM_MODEL) in
 * the environment, "managed mode" turns on:
 *   - GET /api/ai/config tells the client a managed endpoint exists (the model,
 *     never the key or the real URL), so the client points its OpenAI-compatible
 *     provider at a harmless sentinel host and needs no Settings entry.
 *   - The /api/ai/relay handler rewrites any request aimed at that sentinel to
 *     the operator's real base URL, injects the API key, and pins the model.
 *
 * So the browser only ever sees "http://managed.internal/..." — the actual host
 * and secret stay server-side. Managed mode speaks the OpenAI-compatible dialect
 * (Bearer auth, /chat/completions + /models), which is what OH's relay already
 * carries; native Gemini/Anthropic calls never touch the relay and are untouched.
 */

// The client aims its relay calls at this fake host in managed mode. It is never
// resolved by the browser (OpenAI-compatible calls always go through the relay),
// and the relay swaps it for the real endpoint before making the upstream call.
export const MANAGED_AI_HOST = "managed.internal";

// The ONLY sub-paths the key is ever attached to. The client makes exactly these
// two OpenAI-compatible calls (chat completion + model discovery). Restricting to
// them stops a same-origin caller from driving the operator's key against any
// other path on the base host via a hand-crafted sentinel request.
const ALLOWED_MANAGED_PATHS = new Set(["/chat/completions", "/models"]);

// Read the managed-endpoint settings from the environment. Enabled only when both
// a base URL and an API key are present — a base URL alone can't authenticate, and
// a key alone has nowhere to go. LLM_MODEL is optional: when omitted the client
// falls back to OpenAI-style model discovery (GET /models), also relayed.
export function readManagedAiConfig(env = process.env) {
  const baseUrl = String(env.LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(env.LLM_API_KEY ?? "").trim();
  const model = String(env.LLM_MODEL ?? "").trim();
  // Strip the client's reasoning_effort hint server-side. The client sends it by
  // default; a strict gateway/model that rejects unknown fields would 400 every
  // call, and in managed mode the operator otherwise has no way to turn it off.
  const disableReasoning = String(env.LLM_DISABLE_REASONING ?? "").trim() === "1";
  // Completion budget injected into chat calls that don't set one themselves.
  // The game's client never sends max_tokens on OpenAI-compatible calls, so a
  // gateway with a small default cap truncates long turns (a year-long jump is
  // 30+ events of JSON) — the cut-off JSON fails to parse and the turn silently
  // degrades to the canned fallback. LLM_MAX_TOKENS overrides; 0 disables.
  const rawMaxTokens = String(env.LLM_MAX_TOKENS ?? "").trim();
  const parsedMaxTokens = Number.parseInt(rawMaxTokens, 10);
  const maxTokens = rawMaxTokens === "" ? 16384 : Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 0;
  return { baseUrl, apiKey, model, disableReasoning, maxTokens, enabled: Boolean(baseUrl && apiKey) };
}

// The client-facing view of the config: whether a managed endpoint exists and,
// if so, which model to use. Deliberately omits baseUrl and apiKey so neither the
// real host nor the secret is ever sent to a browser.
export function publicManagedAiConfig(config) {
  const enabled = Boolean(config?.enabled);
  return {
    managed: enabled,
    provider: "openai-compatible",
    model: enabled ? config.model || "" : "",
  };
}

// Rewrite a relay request when managed mode is on AND it targets the sentinel host:
// swap in the operator's base URL, inject the Bearer key, and pin the model. The
// original url/headers/payload are returned unchanged when managed mode is off or
// the request isn't aimed at the sentinel (so a player's own direct endpoint, or a
// non-AI relay call, passes through untouched). This is the ONLY place the API key
// is added, and it never crosses back to the browser.
export function applyManagedRelay({ url, headers = {}, payload, method = "POST" } = {}, config) {
  const result = { url, headers: { ...headers }, payload };
  if (!config?.enabled) return result;

  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return result; // unparseable target — leave it for the relay's own error path
  }
  if (parsed.hostname !== MANAGED_AI_HOST) return result;
  // Only the two real OpenAI sub-paths get the key. Anything else aimed at the
  // sentinel is left untouched (it resolves to the fake host and simply fails),
  // so the key can't be attached to an arbitrary path on the base host.
  if (!ALLOWED_MANAGED_PATHS.has(parsed.pathname)) return result;

  // The sentinel host is host-only ("http://managed.internal"), so the client's
  // path IS the OpenAI sub-path (/chat/completions, /models). Append it to the
  // operator's base URL, which carries any version prefix (e.g. .../v1) itself.
  result.url = `${config.baseUrl}${parsed.pathname}${parsed.search}`;
  result.headers = { ...result.headers, Authorization: `Bearer ${config.apiKey}` };

  const isChatPayload =
    method !== "GET" && payload && typeof payload === "object" && !Array.isArray(payload);
  if (isChatPayload) {
    let nextPayload = payload;
    if (config.model) nextPayload = { ...nextPayload, model: config.model };
    if (config.disableReasoning && nextPayload && "reasoning_effort" in nextPayload) {
      nextPayload = { ...nextPayload };
      delete nextPayload.reasoning_effort;
    }
    // Give completions room when the caller didn't ask for a budget itself —
    // see readManagedAiConfig. A caller-provided cap (either spelling) wins.
    if (config.maxTokens > 0 && !("max_tokens" in nextPayload) && !("max_completion_tokens" in nextPayload)) {
      nextPayload = { ...nextPayload, max_tokens: config.maxTokens };
    }
    result.payload = nextPayload;
  }

  return result;
}
