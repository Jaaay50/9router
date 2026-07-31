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
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

const PROBE_ID = "item_probe_cross_request";
const SCHEMA_ERROR = `[400]: ${JSON.stringify({
  error: {
    type: "invalid_request_error",
    code: "invalid_value",
    param: "input[434].id",
    message: `Invalid 'input[434].id': '${PROBE_ID}'. Expected an ID that begins with 'ctc'.`,
  },
})}`;

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

  it("returns the original schema response without account writes or rotation", async () => {
    const originalResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce(account("codex-account-1"))
      .mockResolvedValueOnce(account("codex-account-2"));
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
  });

  it("does not carry a failed request's probe ID into the next valid request", async () => {
    const failedResponse = new Response(JSON.stringify({ error: { message: SCHEMA_ERROR } }), { status: 400 });
    const successResponse = new Response(JSON.stringify({ id: "resp_ok", output: [] }), { status: 200 });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce(account("codex-account-1"))
      .mockResolvedValueOnce(account("codex-account-1"));
    mocks.handleChatCore
      .mockReset()
      .mockResolvedValueOnce({ success: false, status: 400, error: SCHEMA_ERROR, response: failedResponse })
      .mockImplementationOnce(async (options) => {
        await options.onRequestSuccess();
        return { success: true, response: successResponse };
      });

    const first = await handleChat(request({ input: [{ type: "custom_tool_call", id: PROBE_ID, call_id: "call_1", name: "tool", input: "x" }] }));
    const second = await handleChat(request({ input: [{ type: "message", role: "user", content: "valid" }] }));

    expect(first.status).toBe(400);
    expect(second).toBe(successResponse);
    expect(await second.clone().text()).not.toContain(PROBE_ID);
    expect(JSON.stringify(mocks.handleChatCore.mock.calls[1][0].body)).not.toContain(PROBE_ID);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
  });

  it("uses a generic retryable response when every account was already locked", async () => {
    const retryAfter = new Date(Date.now() + 45000).toISOString();
    mocks.getProviderCredentials.mockReset().mockResolvedValue({
      allRateLimited: true,
      retryAfter,
      retryAfterHuman: "reset after 45s",
      lastError: `old ${PROBE_ID}`,
      lastErrorCode: 400,
    });

    const response = await handleChat(request());
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(text).toContain("Temporarily unavailable");
    expect(text).not.toContain(PROBE_ID);
    expect(text).not.toContain("old");
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
