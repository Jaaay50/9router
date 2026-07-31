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
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(() => "masked"),
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

const PROBE_ID = "item_8e297850f5942c40d91db6c2";
const SCHEMA_ERROR = `[codex/gpt-5.6-sol] [400]: ${JSON.stringify({ error: {
  type: "invalid_request_error",
  code: "invalid_value",
  param: "input[58].id",
  message: `Invalid 'input[58].id': '${PROBE_ID}'. Expected an ID that begins with 'ctc'.`,
} })} (reset after 19s)`;

function account(id) {
  return {
    connectionId: id,
    connectionName: id,
    accessToken: "TOKEN",
    providerSpecificData: {},
    _connection: { id },
  };
}

function request(body = {}) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cx/gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "hello" }],
      ...body,
    }),
  });
}

describe("Codex schema 400 account isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue(account("codex-account-1"));
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 30000 });
  });

  it("returns the original 400 before account writes or rotation", async () => {
    const originalResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: SCHEMA_ERROR,
      response: originalResponse,
      resetsAtMs: Date.now() + 30000,
    });

    const response = await handleChat(request());

    expect(response).toBe(originalResponse);
    expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
    expect(mocks.handleChatCore).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("does not leak a schema error into the next valid request", async () => {
    const schemaResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    const successResponse = new Response(JSON.stringify({ id: "resp_valid", output: [] }), { status: 200 });
    mocks.handleChatCore
      .mockResolvedValueOnce({
        success: false,
        status: 400,
        error: SCHEMA_ERROR,
        response: new Response("synthetic", { status: 400 }),
        upstreamResponse: schemaResponse,
      })
      .mockResolvedValueOnce({ success: true, response: successResponse });

    const firstResponse = await handleChat(request());
    const secondResponse = await handleChat(request({ input: [{ type: "message", role: "user", content: "valid" }] }));
    const secondBody = await secondResponse.text();

    expect(firstResponse).toBe(schemaResponse);
    expect(secondResponse).toBe(successResponse);
    expect(secondBody).not.toContain(PROBE_ID);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps 429 account fallback unchanged", async () => {
    const success = new Response("ok", { status: 200 });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce(account("codex-account-1"))
      .mockResolvedValueOnce(account("codex-account-2"));
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "rate limit", response: new Response("rate limit", { status: 429 }) })
      .mockResolvedValueOnce({ success: true, response: success });

    const response = await handleChat(request());

    expect(response).toBe(success);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledOnce();
  });

  it("does not retry Codex through a nested combo", async () => {
    const schemaResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    mocks.getComboModels.mockImplementation(async (model) => {
      if (model === "outer") return ["inner", "cx/gpt-5.6-sol"];
      if (model === "inner") return ["cx/gpt-5.6-sol", "cx/gpt-5.6-codex"];
      return null;
    });
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === "outer" || model === "inner") return { provider: null, model };
      return { provider: "codex", model: model.split("/").at(-1) };
    });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: SCHEMA_ERROR,
      response: new Response("synthetic", { status: 400 }),
      upstreamResponse: schemaResponse,
    });

    const response = await handleChat(request({ model: "outer" }));

    expect(response).toBe(schemaResponse);
    expect(mocks.handleChatCore).toHaveBeenCalledOnce();
    expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("shares provider blocks with a nested fusion combo", async () => {
    const schemaResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: { innerFusion: { fallbackStrategy: "fusion" } },
    });
    mocks.getComboModels.mockImplementation(async (model) => {
      if (model === "outer") return ["cx/gpt-5.6-sol", "innerFusion"];
      if (model === "innerFusion") return ["cx/gpt-5.6-codex", "other/model"];
      return null;
    });
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === "outer" || model === "innerFusion") return { provider: null, model };
      const [prefix, resolvedModel] = model.split("/");
      return { provider: prefix === "cx" ? "codex" : "other", model: resolvedModel };
    });
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => {
      if (modelInfo.provider === "codex") {
        return {
          success: false,
          status: 400,
          error: SCHEMA_ERROR,
          response: new Response("synthetic", { status: 400 }),
          upstreamResponse: schemaResponse,
        };
      }
      return {
        success: true,
        response: new Response(JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      };
    });

    const response = await handleChat(request({ model: "outer" }));
    const calledProviders = mocks.handleChatCore.mock.calls.map(([options]) => options.modelInfo.provider);

    expect(response.ok).toBe(true);
    expect(calledProviders.filter((provider) => provider === "codex")).toHaveLength(1);
    expect(calledProviders.filter((provider) => provider === "other")).toHaveLength(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("skips a blocked provider in a single-model fusion", async () => {
    const schemaResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: { singleFusion: { fallbackStrategy: "fusion" } },
    });
    mocks.getComboModels.mockImplementation(async (model) => {
      if (model === "outer") return ["cx/gpt-5.6-sol", "singleFusion"];
      if (model === "singleFusion") return ["cx/gpt-5.6-codex"];
      return null;
    });
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === "outer" || model === "singleFusion") return { provider: null, model };
      return { provider: "codex", model: model.split("/").at(-1) };
    });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 400,
      error: SCHEMA_ERROR,
      response: new Response("synthetic", { status: 400 }),
      upstreamResponse: schemaResponse,
    });

    const response = await handleChat(request({ model: "outer" }));

    expect(response).toBe(schemaResponse);
    expect(mocks.handleChatCore).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("shares provider queues across nested fusion combos", async () => {
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: {
        outerFusion: { fallbackStrategy: "fusion" },
        innerFusion: { fallbackStrategy: "fusion" },
      },
    });
    mocks.getComboModels.mockImplementation(async (model) => {
      if (model === "outerFusion") return ["cx/gpt-5.6-sol", "innerFusion", "other/a"];
      if (model === "innerFusion") return ["cx/gpt-5.6-codex", "other/b"];
      return null;
    });
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === "outerFusion" || model === "innerFusion") return { provider: null, model };
      const [prefix, resolvedModel] = model.split("/");
      return { provider: prefix === "cx" ? "codex" : "other", model: resolvedModel };
    });
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => {
      if (modelInfo.provider === "codex") {
        return {
          success: false,
          status: 400,
          error: SCHEMA_ERROR,
          response: new Response("synthetic", { status: 400 }),
          upstreamResponse: new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 }),
        };
      }
      return {
        success: true,
        response: new Response(JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: `ok-${modelInfo.model}` }] }],
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      };
    });

    const response = await handleChat(request({ model: "outerFusion" }));
    const calledProviders = mocks.handleChatCore.mock.calls.map(([options]) => options.modelInfo.provider);

    expect(response.ok).toBe(true);
    expect(calledProviders.filter((provider) => provider === "codex")).toHaveLength(1);
    expect(calledProviders.filter((provider) => provider === "other").length).toBeGreaterThanOrEqual(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not replay a stored lastError when all accounts were already locked", async () => {
    const retryAfter = new Date(Date.now() + 45000).toISOString();
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      retryAfter,
      retryAfterHuman: "reset after 45s",
      lastError: `old ${PROBE_ID}`,
      lastErrorCode: 400,
    });

    const response = await handleChat(request());
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).toContain("Temporarily unavailable");
    expect(text).not.toContain(PROBE_ID);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
