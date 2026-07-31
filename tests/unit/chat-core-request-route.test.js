import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    getOutboundFormat: (_model, credentials) => credentials?.requestTargetFormat,
    execute: executeMock,
  }),
}));

vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logOpenAIRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

import { handleChatCore } from "open-sse/handlers/chatCore.js";

describe("handleChatCore request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "fixture" },
      }), { status: 400, headers: { "Content-Type": "application/json" } }),
      url: "https://api.minimax.io/anthropic/v1/messages?beta=true",
      headers: { "x-api-key": "fixture-key" },
      transformedBody: { messages: [] },
      requestFormat: "claude",
    });
  });

  it("passes one model-resolved Claude route to translation, transport, and error context", async () => {
    const credentials = { apiKey: "fixture-key", providerSpecificData: {} };
    const result = await handleChatCore({
      body: {
        model: "MiniMax-M3",
        stream: false,
        max_tokens: 256,
        messages: [{ role: "user", content: "hello" }],
      },
      modelInfo: { provider: "minimax", model: "MiniMax-M3" },
      credentials,
      sourceFormatOverride: "openai",
      connectionId: "route-fixture",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        headers: { accept: "application/json" },
        body: {},
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(credentials.runtimeTransport?.format).toBe("claude");
    expect(credentials.requestTargetFormat).toBe("claude");
    expect(executeMock).toHaveBeenCalledOnce();
    expect(executeMock.mock.calls[0][0].credentials).toBe(credentials);
    expect(executeMock.mock.calls[0][0].body.messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "hello" }],
    }]);
    expect(result).toEqual(expect.objectContaining({
      success: false,
      status: 400,
      targetFormat: "claude",
    }));
  });
});
