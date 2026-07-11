/*! Pax Colonia — client side of the server-baked LLM endpoint (see server/managedAi.js).
 *
 * At startup the client asks the server whether a managed LLM endpoint exists. If
 * it does, we point the OpenAI-compatible provider at a sentinel host and clear any
 * local key — the server rewrites the sentinel to the real endpoint and injects the
 * key at relay time, so the player never touches Settings and the secret never
 * reaches the browser. When no managed endpoint is configured (stock install), this
 * is a no-op and the player configures their own provider as usual.
 */
import { getProviderField, setProviderField } from "../Game/AI/providerConfig.js";

// Must match server/managedAi.js MANAGED_AI_HOST. Host-only (no /v1): the client's
// OpenAI sub-path (/chat/completions, /models) becomes the URL path, which the
// server appends to the real base URL. OpenAI-compatible calls always go through
// the relay, so the browser never actually resolves this host.
const MANAGED_ENDPOINT = "http://managed.internal";

// Remembers that THIS browser adopted managed mode, so that if the operator later
// turns managed mode off we know to undo the sentinel settings (rather than leave
// the browser calling a dead host forever).
const MANAGED_MARKER = "oh_managed_ai";

// Fetch the server's AI config and reconcile the local provider settings with it.
// Runs every startup, so turning managed mode on OR off is reflected on the next
// load. Never throws — a failed fetch just leaves the player's own settings alone.
export async function applyManagedAiConfig({ signal } = {}) {
  let config;
  try {
    const response = await fetch("/api/ai/config", { cache: "no-store", signal });
    if (!response.ok) return { managed: false };
    config = await response.json();
  } catch {
    return { managed: false };
  }

  if (config?.managed) {
    // Managed mode is OpenAI-compatible (Bearer, /chat/completions). Point the
    // provider at the sentinel, store the model for display + to skip discovery,
    // and clear the key field — the real key lives only on the server.
    localStorage.setItem("api_provider", "openai-compatible");
    setProviderField("openai-compatible", "endpoint", MANAGED_ENDPOINT);
    setProviderField("openai-compatible", "model", config.model || "");
    setProviderField("openai-compatible", "apiKey", "");
    localStorage.setItem(MANAGED_MARKER, "1");
    return { managed: true, model: config.model || "" };
  }

  // Managed mode is off. If this browser was previously managed, undo the sentinel
  // settings so it isn't stuck relaying to a dead host — fall back to the stock
  // "no provider chosen" state and let the player configure their own. Only clear
  // the endpoint if it is still the sentinel, so a player who has since set their
  // own endpoint keeps it.
  if (localStorage.getItem(MANAGED_MARKER) === "1") {
    localStorage.removeItem(MANAGED_MARKER);
    if (getProviderField("openai-compatible", "endpoint") === MANAGED_ENDPOINT) {
      setProviderField("openai-compatible", "endpoint", "");
    }
    localStorage.removeItem("api_provider");
  }
  return { managed: false };
}
