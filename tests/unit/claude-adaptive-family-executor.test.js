import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { GithubExecutor } = await import("../../open-sse/executors/github.js");

describe("Claude adaptive family final outbound payload", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("upstream fixture", { status: 400 }));
  });

  it.each([
    "claude-opus-4.6",
    "claude-opus-4-8-thinking",
    "vendor/claude-opus-4.8-fast-20260731",
    "claude-sonnet-4.6-1m",
    "claude-sonnet-4.6-thinking-1m",
    "claude-sonnet-4.7-agentic",
    "claude-sonnet-5-2026-07-31",
    "claude-fable-5-fast",
  ])("sends %s with adaptive thinking and the 128K output ceiling", async (model) => {
    const executor = new GithubExecutor();
    const result = await executor.execute({
      model,
      body: {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 200000,
        reasoning_effort: "high",
      },
      stream: true,
      credentials: { copilotToken: "TOKEN" },
      signal: undefined,
      log: null,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/messages");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toEqual(result.transformedBody);
    expect(sentBody.max_tokens).toBe(128000);
    expect(sentBody.output_config).toEqual({ effort: "high" });
    expect(sentBody.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sentBody.thinking).not.toHaveProperty("budget_tokens");
  });
});
