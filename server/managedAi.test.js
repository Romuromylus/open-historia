// Unit tests for the server-baked LLM endpoint helpers. Run with `npm test`
// (node --test). Pure functions — no server boot, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MANAGED_AI_HOST,
  applyManagedRelay,
  publicManagedAiConfig,
  readManagedAiConfig,
} from "./managedAi.js";

const CHAT_URL = `http://${MANAGED_AI_HOST}/chat/completions`;
const MODELS_URL = `http://${MANAGED_AI_HOST}/models`;
const ENABLED = { baseUrl: "https://llm.example.com/v1", apiKey: "sk-secret", model: "gpt-x", enabled: true };

test("readManagedAiConfig enables only with both base URL and key", () => {
  assert.equal(readManagedAiConfig({}).enabled, false);
  assert.equal(readManagedAiConfig({ LLM_BASE_URL: "https://x/v1" }).enabled, false);
  assert.equal(readManagedAiConfig({ LLM_API_KEY: "k" }).enabled, false);

  const cfg = readManagedAiConfig({ LLM_BASE_URL: "https://x/v1", LLM_API_KEY: "k", LLM_MODEL: "m" });
  assert.deepEqual(cfg, {
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    disableReasoning: false,
    reasoningEffort: "",
    maxTokens: 16384,
    enabled: true,
  });
});

test("readManagedAiConfig validates LLM_REASONING_EFFORT (low/medium/high only)", () => {
  const env = { LLM_BASE_URL: "https://x", LLM_API_KEY: "k" };
  assert.equal(readManagedAiConfig(env).reasoningEffort, "");
  assert.equal(readManagedAiConfig({ ...env, LLM_REASONING_EFFORT: "Medium" }).reasoningEffort, "medium");
  assert.equal(readManagedAiConfig({ ...env, LLM_REASONING_EFFORT: "maximum" }).reasoningEffort, "");
});

test("readManagedAiConfig reads LLM_MAX_TOKENS (default 16384, 0 disables, junk disables)", () => {
  const env = { LLM_BASE_URL: "https://x", LLM_API_KEY: "k" };
  assert.equal(readManagedAiConfig(env).maxTokens, 16384);
  assert.equal(readManagedAiConfig({ ...env, LLM_MAX_TOKENS: "32000" }).maxTokens, 32000);
  assert.equal(readManagedAiConfig({ ...env, LLM_MAX_TOKENS: "0" }).maxTokens, 0);
  assert.equal(readManagedAiConfig({ ...env, LLM_MAX_TOKENS: "lots" }).maxTokens, 0);
});

test("readManagedAiConfig reads LLM_DISABLE_REASONING", () => {
  assert.equal(readManagedAiConfig({ LLM_BASE_URL: "https://x", LLM_API_KEY: "k" }).disableReasoning, false);
  assert.equal(
    readManagedAiConfig({ LLM_BASE_URL: "https://x", LLM_API_KEY: "k", LLM_DISABLE_REASONING: "1" }).disableReasoning,
    true,
  );
});

test("readManagedAiConfig trims whitespace and a trailing slash on the base URL", () => {
  const cfg = readManagedAiConfig({ LLM_BASE_URL: "  https://x/v1/  ", LLM_API_KEY: "  k  ", LLM_MODEL: "  m  " });
  assert.equal(cfg.baseUrl, "https://x/v1");
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.model, "m");
});

test("publicManagedAiConfig hides the base URL and key", () => {
  assert.deepEqual(publicManagedAiConfig(ENABLED), {
    managed: true,
    provider: "openai-compatible",
    model: "gpt-x",
  });
  // No secret fields leak, whatever the shape.
  const keys = Object.keys(publicManagedAiConfig(ENABLED));
  assert.ok(!keys.includes("baseUrl") && !keys.includes("apiKey"));

  assert.deepEqual(publicManagedAiConfig({ enabled: false }), {
    managed: false,
    provider: "openai-compatible",
    model: "",
  });
});

test("applyManagedRelay is a no-op when managed mode is off", () => {
  const input = { url: CHAT_URL, headers: { "X-A": "1" }, payload: { model: "orig" }, method: "POST" };
  const out = applyManagedRelay(input, { enabled: false });
  assert.equal(out.url, CHAT_URL);
  assert.deepEqual(out.headers, { "X-A": "1" });
  assert.deepEqual(out.payload, { model: "orig" });
});

test("applyManagedRelay rewrites a sentinel chat call: real URL, injected key, pinned model", () => {
  const out = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { model: "orig", messages: [] } }, ENABLED);
  assert.equal(out.url, "https://llm.example.com/v1/chat/completions");
  assert.equal(out.headers.Authorization, "Bearer sk-secret");
  assert.equal(out.payload.model, "gpt-x");
  assert.deepEqual(out.payload.messages, []);
});

test("applyManagedRelay rewrites a sentinel GET /models without touching the (absent) payload", () => {
  const out = applyManagedRelay({ url: MODELS_URL, headers: {}, method: "GET" }, ENABLED);
  assert.equal(out.url, "https://llm.example.com/v1/models");
  assert.equal(out.headers.Authorization, "Bearer sk-secret");
  assert.equal(out.payload, undefined);
});

test("applyManagedRelay leaves a non-sentinel host untouched even when managed", () => {
  const url = "https://player-own-endpoint.test/v1/chat/completions";
  const out = applyManagedRelay({ url, headers: { Authorization: "Bearer player" }, payload: { model: "p" } }, ENABLED);
  assert.equal(out.url, url);
  assert.equal(out.headers.Authorization, "Bearer player");
  assert.equal(out.payload.model, "p");
});

test("applyManagedRelay does not pin the model when none is configured", () => {
  const noModel = { ...ENABLED, model: "" };
  const out = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { model: "orig" } }, noModel);
  assert.equal(out.url, "https://llm.example.com/v1/chat/completions");
  assert.equal(out.headers.Authorization, "Bearer sk-secret");
  assert.equal(out.payload.model, "orig");
});

test("applyManagedRelay does NOT attach the key to a non-allowlisted sentinel path", () => {
  // A hand-crafted relay call to an arbitrary path on the sentinel must not get
  // the operator's key (no open, key-attached proxy across the base host).
  for (const path of ["/v1/models", "/admin", "/chat/completions/../secrets", "/embeddings"]) {
    const url = `http://${MANAGED_AI_HOST}${path}`;
    const out = applyManagedRelay({ url, headers: {}, payload: { model: "x" }, method: "POST" }, ENABLED);
    assert.equal(out.url, url, `path ${path} must be left unchanged`);
    assert.equal(out.headers.Authorization, undefined, `path ${path} must not get the key`);
  }
});

test("applyManagedRelay strips reasoning_effort when the operator disables reasoning", () => {
  const cfg = { ...ENABLED, disableReasoning: true };
  const out = applyManagedRelay(
    { url: CHAT_URL, headers: {}, payload: { model: "orig", reasoning_effort: "medium", messages: [] } },
    cfg,
  );
  assert.equal(out.url, "https://llm.example.com/v1/chat/completions");
  assert.equal("reasoning_effort" in out.payload, false);
  assert.equal(out.payload.model, "gpt-x");
  assert.deepEqual(out.payload.messages, []);
});

test("applyManagedRelay keeps reasoning_effort when reasoning is not disabled", () => {
  const out = applyManagedRelay(
    { url: CHAT_URL, headers: {}, payload: { model: "orig", reasoning_effort: "medium" } },
    ENABLED,
  );
  assert.equal(out.payload.reasoning_effort, "medium");
});

test("applyManagedRelay pins the operator's reasoning level (set or override)", () => {
  const cfg = { ...ENABLED, reasoningEffort: "high" };
  const overridden = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { reasoning_effort: "medium" } }, cfg);
  assert.equal(overridden.payload.reasoning_effort, "high");
  const injected = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { messages: [] } }, cfg);
  assert.equal(injected.payload.reasoning_effort, "high");
});

test("applyManagedRelay: LLM_DISABLE_REASONING wins over a pinned level", () => {
  const cfg = { ...ENABLED, disableReasoning: true, reasoningEffort: "high" };
  const out = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { reasoning_effort: "medium" } }, cfg);
  assert.equal("reasoning_effort" in out.payload, false);
});

test("applyManagedRelay injects the completion budget when the chat payload has none", () => {
  const cfg = { ...ENABLED, maxTokens: 16384 };
  const out = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { model: "orig", messages: [] } }, cfg);
  assert.equal(out.payload.max_tokens, 16384);
});

test("applyManagedRelay never overrides a caller-provided completion cap (either spelling)", () => {
  const cfg = { ...ENABLED, maxTokens: 16384 };
  const explicit = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { max_tokens: 512 } }, cfg);
  assert.equal(explicit.payload.max_tokens, 512);
  const modern = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { max_completion_tokens: 512 } }, cfg);
  assert.equal(modern.payload.max_completion_tokens, 512);
  assert.equal("max_tokens" in modern.payload, false);
});

test("applyManagedRelay skips the budget when disabled (maxTokens 0) and on GET /models", () => {
  const off = applyManagedRelay({ url: CHAT_URL, headers: {}, payload: { model: "x" } }, { ...ENABLED, maxTokens: 0 });
  assert.equal("max_tokens" in off.payload, false);
  const models = applyManagedRelay({ url: MODELS_URL, headers: {}, method: "GET" }, { ...ENABLED, maxTokens: 16384 });
  assert.equal(models.payload, undefined);
});

test("applyManagedRelay tolerates an unparseable URL", () => {
  const out = applyManagedRelay({ url: "not a url", headers: {}, payload: {} }, ENABLED);
  assert.equal(out.url, "not a url");
});
