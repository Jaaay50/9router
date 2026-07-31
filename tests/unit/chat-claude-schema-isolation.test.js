import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(() => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: mocks.logWarn,
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

const SCHEMA_ERROR = `[anthropic/claude-opus-4-8] [400]: ${JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "context_management: Extra inputs are not permitted",
  },
})} (reset after 16s)`;

function account(id) {
  return {
    connectionId: id,
    connectionName: id,
    accessToken: "TOKEN",
    providerSpecificData: {},
    _connection: { id },
  };
}

function request(overrides = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-opus-4-8",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      context_management: null,
      ...overrides,
    }),
  });
}

function openAIRequest(overrides = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "minimax/MiniMax-M3",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
      context_management: null,
      ...overrides,
    }),
  });
}

describe("Claude schema 400 account isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-opus-4-8" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue(account("anthropic-account-1"));
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 30000 });
  });

  it("returns the original response without account writes, rotation, or cooldown", async () => {
    const originalResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce(account("anthropic-account-1"))
      .mockResolvedValueOnce(account("anthropic-account-2"));
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: SCHEMA_ERROR,
      response: originalResponse,
    });

    const response = await handleChat(request());

    expect(response).toBe(originalResponse);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(response.headers.get("Retry-After")).toBeNull();
    expect([...response.headers.keys()]).not.toContain("x-9router-target-format");
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "REQUEST",
      "Non-retryable provider request schema error (400)",
      { provider: "anthropic" },
    );
    expect(mocks.logWarn.mock.calls.flat().join(" ")).not.toContain("Codex request schema");
  });

  it("does not carry a Claude schema failure into the next valid request", async () => {
    const failedResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    const successResponse = new Response(JSON.stringify({ id: "msg_ok", content: [] }), { status: 200 });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce(account("anthropic-account-1"))
      .mockResolvedValueOnce(account("anthropic-account-1"));
    mocks.handleChatCore
      .mockReset()
      .mockResolvedValueOnce({ success: false, status: 400, error: SCHEMA_ERROR, response: failedResponse })
      .mockImplementationOnce(async (options) => {
        await options.onRequestSuccess();
        return { success: true, response: successResponse };
      });

    const first = await handleChat(request());
    const second = await handleChat(request({ context_management: undefined }));

    expect(first.status).toBe(400);
    expect(second).toBe(successResponse);
    expect(await second.clone().text()).not.toContain("context_management");
    expect(JSON.stringify(mocks.handleChatCore.mock.calls[1][0].body)).not.toContain("context_management");
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
  });

  it("keeps an OpenAI route on a mixed provider on normal account fallback", async () => {
    const originalResponse = new Response(JSON.stringify({ error: { message: "response_format: Extra inputs are not permitted" } }), {
      status: 400,
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "glm-5.2" });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: "response_format: Extra inputs are not permitted",
      targetFormat: "openai",
      response: originalResponse,
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 30000 });

    const response = await handleChat(request({ model: "opencode-go/glm-5.2" }));

    expect(response).toBe(originalResponse);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable.mock.calls[0][6]).toEqual({ targetFormat: "openai" });
  });

  it("isolates the Claude route on a mixed provider before account state writes", async () => {
    const originalResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), {
      status: 400,
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "minimax-m3" });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: SCHEMA_ERROR,
      targetFormat: "claude",
      response: originalResponse,
    });

    const response = await handleChat(request({ model: "opencode-go/minimax-m3" }));

    expect(response).toBe(originalResponse);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("classifies a model-forced Claude route from OpenAI input using the same route resolver", async () => {
    const originalResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), {
      status: 400,
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "minimax", model: "MiniMax-M3" });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: SCHEMA_ERROR,
      response: originalResponse,
    });

    const response = await handleChat(openAIRequest());

    expect(response).toBe(originalResponse);
    expect(mocks.handleChatCore).toHaveBeenCalledOnce();
    expect(mocks.handleChatCore.mock.calls[0][0].sourceFormatOverride).toBe("openai");
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
