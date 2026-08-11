import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore upstream errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the original provider response before parsing its body", async () => {
    const upstreamBody = {
      error: {
        type: "invalid_request_error",
        code: "invalid_value",
        param: "input[434].id",
        message: "Invalid 'input[434].id': 'item_probe'. Expected an ID that begins with 'ctc'.",
      },
    };
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(upstreamBody), {
        status: 400,
        statusText: "Bad Request",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "999",
          "transfer-encoding": "chunked",
          "set-cookie": "upstream-session=secret",
          "x-request-id": "req_schema_probe",
        },
      }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: null,
    });

    const result = await handleChatCore({
      body: {
        model: "gpt-5.6-sol",
        stream: false,
        input: [{ type: "message", role: "user", content: "hello" }],
      },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
      credentials: { accessToken: "TOKEN", providerSpecificData: {} },
      connectionId: "codex-account-1",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: {},
        headers: { accept: "application/json" },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.upstreamResponse.status).toBe(400);
    expect(result.upstreamResponse.statusText).toBe("Bad Request");
    expect(result.upstreamResponse.headers.get("x-request-id")).toBe("req_schema_probe");
    expect(result.upstreamResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(result.upstreamResponse.headers.get("content-encoding")).toBeNull();
    expect(result.upstreamResponse.headers.get("content-length")).toBeNull();
    expect(result.upstreamResponse.headers.get("transfer-encoding")).toBeNull();
    expect(result.upstreamResponse.headers.get("set-cookie")).toBeNull();
    await expect(result.upstreamResponse.json()).resolves.toEqual(upstreamBody);
    await expect(result.response.json()).resolves.not.toEqual(upstreamBody);
  });

  it("keeps non-schema error results unchanged", async () => {
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: null,
    });

    const result = await handleChatCore({
      body: {
        model: "gpt-5.6-sol",
        stream: false,
        input: [{ type: "message", role: "user", content: "hello" }],
      },
      modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
      credentials: { accessToken: "TOKEN", providerSpecificData: {} },
      connectionId: "codex-account-1",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: {},
        headers: { accept: "application/json" },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.status).toBe(429);
    expect(result).not.toHaveProperty("upstreamResponse");
  });
});
