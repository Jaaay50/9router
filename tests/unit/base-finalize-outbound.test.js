import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

describe("BaseExecutor.finalizeOutboundRequest", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
    });
  });

  it("uses the finalized URL, headers, and body for the upstream fetch", async () => {
    const { BaseExecutor } = await import("open-sse/executors/base.js");
    class FinalizingExecutor extends BaseExecutor {
      finalizeOutboundRequest({ url, headers, transformedBody }) {
        return {
          url: `${url}?finalized=true`,
          headers: { ...headers, "x-finalized": "yes" },
          transformedBody: { ...transformedBody, finalized: true },
        };
      }
    }

    const executor = new FinalizingExecutor("fixture", {
      baseUrl: "https://upstream.example.com/messages",
      headers: {},
      retry: {},
    });
    const result = await executor.execute({
      model: "fixture-model",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "fixture-key" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://upstream.example.com/messages?finalized=true",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-finalized": "yes" }),
        body: JSON.stringify({ messages: [], finalized: true }),
      }),
      null
    );
    expect(result.url).toBe("https://upstream.example.com/messages?finalized=true");
    expect(result.transformedBody.finalized).toBe(true);
  });

  it.each([
    ["minimax-m3", false, "claude"],
    ["glm-5.2", true, "openai"],
  ])("applies the shared policy to OpenCode Go route %s", async (model, keepsContext, requestFormat) => {
    const { OpenCodeGoExecutor } = await import("open-sse/executors/opencode-go.js");
    const executor = new OpenCodeGoExecutor();
    const result = await executor.execute({
      model,
      body: { messages: [], context_management: null },
      stream: false,
      credentials: { apiKey: "connection-key" },
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.prototype.hasOwnProperty.call(sent, "context_management")).toBe(keepsContext);
    expect(result.requestFormat).toBe(requestFormat);
  });

  it("keeps OpenCode's dormant messages route behind the same policy", async () => {
    const { OpenCodeExecutor } = await import("open-sse/executors/opencode.js");
    const executor = new OpenCodeExecutor();
    executor.usesMessagesEndpoint = () => true;

    await executor.execute({
      model: "future-claude-model",
      body: { messages: [], context_management: null },
      stream: false,
      credentials: {},
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).not.toHaveProperty("context_management");
    expect(fetchMock.mock.calls[0][0]).toContain("/messages");
  });

  it("runs GitHub's direct messages fetch through the finalizer without forwarding client auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "fixture" },
    }), { status: 400 }));
    const { GithubExecutor } = await import("open-sse/executors/github.js");
    class InspectableGithubExecutor extends GithubExecutor {
      finalizeOutboundRequest(options) {
        const finalized = super.finalizeOutboundRequest(options);
        return {
          ...finalized,
          headers: { ...finalized.headers, "x-finalized": "yes" },
        };
      }
    }
    const executor = new InspectableGithubExecutor();

    const result = await executor.executeWithMessagesEndpoint({
      model: "claude-opus-4.8",
      body: { messages: [{ role: "user", content: "hello" }], context_management: null },
      stream: false,
      credentials: {
        copilotToken: "connection-token",
        rawHeaders: {
          authorization: "Bearer client-token",
          "x-api-key": "client-key",
          cookie: "client-cookie=1",
        },
      },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer connection-token");
    expect(options.headers["x-api-key"]).toBeUndefined();
    expect(options.headers.cookie).toBeUndefined();
    expect(options.headers["x-finalized"]).toBe("yes");
    expect(result.requestFormat).toBe("claude");
  });
});
