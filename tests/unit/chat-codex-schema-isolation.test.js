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

});
