import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: authMocks.getProviderConnections,
  updateProviderConnection: authMocks.updateProviderConnection,
  getSettings: authMocks.getSettings,
  getProxyPools: vi.fn().mockResolvedValue([]),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  }),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((provider) => provider),
  FREE_PROVIDERS: {},
}));

vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

import {
  classifyProviderError,
  classifyProviderErrorForRequest,
  isClaudeRequestSchemaError,
  isClaudeRequestSchemaErrorForRequest,
  setResponseErrorContext,
} from "../../open-sse/services/accountFallback.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

const CLAUDE_SCHEMA_ERROR = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "context_management: Extra inputs are not permitted",
  },
  request_id: "req_probe",
};

const SCREENSHOT_ERROR = `[anthropic/claude-opus-4-8] [400]: ${JSON.stringify(CLAUDE_SCHEMA_ERROR)} (reset after 16s)`;
const CLASSIFICATION = {
  category: "request_schema",
  accountFallback: false,
  cooldownMs: 0,
  comboScope: "provider",
};
const log = { info: vi.fn(), warn: vi.fn() };

function errorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Claude request schema classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    authMocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  it.each([
    ["Anthropic error envelope", "anthropic", CLAUDE_SCHEMA_ERROR],
    ["raw JSON", "anthropic", JSON.stringify(CLAUDE_SCHEMA_ERROR)],
    ["status-wrapped JSON", "anthropic", `[400]: ${JSON.stringify(CLAUDE_SCHEMA_ERROR)}`],
    ["screenshot wrapper with stale cooldown", "anthropic", SCREENSHOT_ERROR],
    ["missing inner type", "anthropic", { error: { message: "messages.4.content.1.cache_control: Extra inputs are not permitted" } }],
    ["quoted field path", "anthropic", { error: { message: "'context_management': Extra inputs are not permitted" } }],
    ["Claude OAuth provider", "claude", CLAUDE_SCHEMA_ERROR],
    ["Anthropic-compatible provider", "anthropic-compatible-company", CLAUDE_SCHEMA_ERROR],
    ["invalid anthropic-beta value", "anthropic", {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "anthropic-beta header contains an unsupported value: future-beta-2099-01-01",
      },
    }],
  ])("classifies %s without account fallback", (_name, provider, value) => {
    expect(isClaudeRequestSchemaError(provider, 400, value)).toBe(true);
    expect(classifyProviderError(provider, 400, value)).toEqual(CLASSIFICATION);
  });

  it.each([
    ["DeepSeek Claude transport", "deepseek"],
    ["OpenCode Go Claude model", "opencode-go"],
    ["Kimi Claude transport", "kimi"],
  ])("classifies %s only for the current Claude wire format", (_name, provider) => {
    expect(isClaudeRequestSchemaErrorForRequest(FORMATS.CLAUDE, 400, CLAUDE_SCHEMA_ERROR)).toBe(true);
    expect(classifyProviderErrorForRequest(provider, 400, CLAUDE_SCHEMA_ERROR, 0, {
      targetFormat: FORMATS.CLAUDE,
    })).toEqual(CLASSIFICATION);
  });

  it.each(["opencode-go", "deepseek", "kimi"])(
    "keeps %s OpenAI route schema errors on normal fallback",
    provider => {
      const openaiError = {
        type: "invalid_request_error",
        message: "response_format: Extra inputs are not permitted",
      };
      expect(isClaudeRequestSchemaErrorForRequest(FORMATS.OPENAI, 400, openaiError)).toBe(false);
      expect(classifyProviderErrorForRequest(provider, 400, openaiError, 0, {
        targetFormat: FORMATS.OPENAI,
      })).toEqual({
        category: "provider_error",
        accountFallback: true,
        cooldownMs: 30000,
        comboScope: "model",
      });
    }
  );

  it.each([
    ["non-Claude provider", "openai", 400, CLAUDE_SCHEMA_ERROR],
    ["unauthorized", "anthropic", 401, CLAUDE_SCHEMA_ERROR],
    ["forbidden", "anthropic", 403, CLAUDE_SCHEMA_ERROR],
    ["rate limit", "anthropic", 429, CLAUDE_SCHEMA_ERROR],
    ["server error", "anthropic", 500, CLAUDE_SCHEMA_ERROR],
    ["invalid_prompt code", "anthropic", 400, { error: { type: "invalid_request_error", code: "invalid_prompt", message: "context_management: Extra inputs are not permitted" } }],
    ["invalid_prompt type", "anthropic", 400, { error: { type: "invalid_prompt", message: "context_management: Extra inputs are not permitted" } }],
    ["invalid_prompt message", "anthropic", 400, { error: { type: "invalid_request_error", message: "Invalid prompt: context_management: Extra inputs are not permitted" } }],
    ["context limit", "anthropic", 400, { error: { type: "invalid_request_error", message: "prompt is too long: 220000 tokens > 200000 maximum" } }],
    ["model permission", "anthropic", 400, { error: { type: "invalid_request_error", message: "You do not have access to model claude-opus-4-8" } }],
    ["account beta permission", "anthropic", 400, { error: { type: "invalid_request_error", message: "Your account does not have permission to use the anthropic-beta header value" } }],
    ["unsupported beta for account", "anthropic", 400, { error: { type: "invalid_request_error", message: "Unsupported anthropic-beta header value for this account" } }],
    ["organization beta entitlement", "anthropic", 400, { error: { type: "invalid_request_error", message: "The anthropic-beta header value is not enabled for this organization" } }],
    ["model beta entitlement", "anthropic", 400, { error: { type: "invalid_request_error", message: "Model claude-opus-4-8 does not have access to this anthropic-beta header value" } }],
    ["model not found", "anthropic", 400, { error: { type: "invalid_request_error", message: "model: claude-opus-4-8 not found" } }],
    ["capacity", "anthropic", 400, { error: { type: "invalid_request_error", message: "Selected model is at capacity" } }],
    ["overloaded type", "anthropic", 400, { error: { type: "overloaded_error", message: "context_management: Extra inputs are not permitted" } }],
    ["no field path", "anthropic", 400, { error: { type: "invalid_request_error", message: "Extra inputs are not permitted" } }],
    ["unrelated invalid request", "anthropic", 400, { error: { type: "invalid_request_error", message: "temperature must be between 0 and 1" } }],
  ])("does not classify %s", (_name, provider, status, value) => {
    expect(isClaudeRequestSchemaError(provider, status, value)).toBe(false);
  });

  it("does not persist an account lock when the defensive marker receives the schema 400", async () => {
    authMocks.getProviderConnections.mockResolvedValue([{
      id: "anthropic-account-1",
      provider: "anthropic",
      displayName: "anthropic-account-1",
      backoffLevel: 0,
    }]);

    const result = await markAccountUnavailable(
      "anthropic-account-1",
      400,
      SCREENSHOT_ERROR,
      "anthropic",
      "claude-opus-4-8",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(authMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not persist an account lock for a provider with Claude-target models", async () => {
    authMocks.getProviderConnections.mockResolvedValue([{
      id: "opencode-go-account-1",
      provider: "opencode-go",
      displayName: "opencode-go-account-1",
      backoffLevel: 0,
    }]);

    const result = await markAccountUnavailable(
      "opencode-go-account-1",
      400,
      CLAUDE_SCHEMA_ERROR,
      "opencode-go",
      "minimax-m3",
      null,
      { targetFormat: FORMATS.CLAUDE },
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(authMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("persists normal fallback for an OpenAI route on the same mixed provider", async () => {
    authMocks.getProviderConnections.mockResolvedValue([{
      id: "opencode-go-account-1",
      provider: "opencode-go",
      displayName: "opencode-go-account-1",
      backoffLevel: 0,
    }]);

    const result = await markAccountUnavailable(
      "opencode-go-account-1",
      400,
      { type: "invalid_request_error", message: "response_format: Extra inputs are not permitted" },
      "opencode-go",
      "glm-5.2",
      null,
      { targetFormat: FORMATS.OPENAI },
    );

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 30000 });
    expect(authMocks.updateProviderConnection).toHaveBeenCalledOnce();
  });

  it.each([
    "Your account does not have permission to use the anthropic-beta header value",
    "Unsupported anthropic-beta header value for this account",
    "The anthropic-beta header value is not enabled for this organization",
    "Model claude-opus-4-8 does not have access to this anthropic-beta header value",
  ])("keeps beta permission errors on normal account fallback: %s", message => {
    expect(classifyProviderError("anthropic", 400, {
      error: { type: "invalid_request_error", message },
    })).toEqual({
      category: "provider_error",
      accountFallback: true,
      cooldownMs: 30000,
      comboScope: "model",
    });
  });
});

describe("Claude provider-scoped Combo fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the remaining Anthropic models after the first schema 400", async () => {
    const firstResponse = errorResponse(400, CLAUDE_SCHEMA_ERROR);
    const handleSingleModel = vi.fn().mockResolvedValue(firstResponse);

    const response = await handleComboChat({
      body: {},
      models: ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-6"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("continues a heterogeneous Combo after the Anthropic schema 400", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return model.startsWith("openai/")
        ? new Response("ok", { status: 200 })
        : errorResponse(400, CLAUDE_SCHEMA_ERROR);
    });

    const response = await handleComboChat({
      body: {},
      models: ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-6", "openai/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["anthropic/claude-opus-4-8", "openai/gpt-5.5"]);
  });

  it("returns the first Claude schema 400 when other providers also fail", async () => {
    const firstResponse = errorResponse(400, CLAUDE_SCHEMA_ERROR);
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(errorResponse(429, { type: "rate_limit_error", message: "rate limit" }));

    const response = await handleComboChat({
      body: {},
      models: ["anthropic/claude-opus-4-8", "openai/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it.each([429, 502, 503, 504])("keeps normal fallback for HTTP %s", async (status) => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errorResponse(status, { message: status === 429 ? "rate limit" : "upstream unavailable" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: {},
      models: ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-6"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("blocks only the rejected Claude format within a mixed provider", async () => {
    const calls = [];
    const claudeError = errorResponse(400, CLAUDE_SCHEMA_ERROR);
    setResponseErrorContext(claudeError, {
      classification: CLASSIFICATION,
      targetFormat: FORMATS.CLAUDE,
    });
    const contexts = {
      "opencode-go/minimax-m3": { provider: "opencode-go", targetFormat: FORMATS.CLAUDE },
      "opencode-go/qwen3.7-max": { provider: "opencode-go", targetFormat: FORMATS.CLAUDE },
      "opencode-go/glm-5.2": { provider: "opencode-go", targetFormat: FORMATS.OPENAI },
    };
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return model.endsWith("glm-5.2") ? new Response("ok", { status: 200 }) : claudeError;
    });

    const response = await handleComboChat({
      body: {},
      models: Object.keys(contexts),
      handleSingleModel,
      log,
      autoSwitch: false,
      resolveModelContext: async model => contexts[model],
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["opencode-go/minimax-m3", "opencode-go/glm-5.2"]);
  });

  it("does not let an OpenAI schema 400 block the Claude route on the same provider", async () => {
    const calls = [];
    const contexts = {
      "opencode-go/glm-5.2": { provider: "opencode-go", targetFormat: FORMATS.OPENAI },
      "opencode-go/minimax-m3": { provider: "opencode-go", targetFormat: FORMATS.CLAUDE },
    };
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return model.endsWith("minimax-m3")
        ? new Response("ok", { status: 200 })
        : errorResponse(400, {
          type: "invalid_request_error",
          message: "response_format: Extra inputs are not permitted",
        });
    });

    const response = await handleComboChat({
      body: {},
      models: Object.keys(contexts),
      handleSingleModel,
      log,
      autoSwitch: false,
      resolveModelContext: async model => contexts[model],
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(Object.keys(contexts));
  });
});
