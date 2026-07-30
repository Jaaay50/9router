/**
 * Regression test for #1062:
 * GitHub Copilot's /responses endpoint only serves OpenAI (gpt/codex) models.
 * Gemini/Claude models must never be routed/escalated there, otherwise they
 * fail with a misleading 400 "does not support Responses API".
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { GithubExecutor } = await import("../../open-sse/executors/github.js");

beforeEach(() => {
  fetchMock.mockReset();
});

describe("GithubExecutor.supportsResponsesEndpoint", () => {
  const exec = new GithubExecutor();

  it("excludes Gemini models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-preview")).toBe(false);
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-low")).toBe(false);
  });

  it("excludes Claude models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("claude-sonnet-4.6")).toBe(false);
    expect(exec.supportsResponsesEndpoint("claude-opus-4.7")).toBe(false);
  });

  it("allows OpenAI/codex models on the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gpt-5.5-codex")).toBe(true);
    expect(exec.supportsResponsesEndpoint("o4-mini")).toBe(true);
    expect(exec.supportsResponsesEndpoint("gpt-4.1")).toBe(true);
  });

  it("is null-safe", () => {
    expect(exec.supportsResponsesEndpoint(undefined)).toBe(true);
    expect(exec.supportsResponsesEndpoint("")).toBe(true);
  });
});

describe("GithubExecutor.execute cached-route guard (#1062)", () => {
  it("does NOT use /responses for a Gemini model even if it was wrongly cached as codex", async () => {
    const exec = new GithubExecutor();
    // Simulate a prior misclassification that cached the Gemini model.
    exec.knownCodexModels.add("gemini-3.1-pro-preview");

    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses" });
    // Short-circuit the /chat/completions path (BaseExecutor.execute).
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    const result = await exec.execute({ model: "gemini-3.1-pro-preview", body: { messages: [] }, log: null });

    expect(respSpy).not.toHaveBeenCalled();
    expect(baseSpy).toHaveBeenCalled();
    expect(result.via).toBe("chat");
  });
});

describe("GithubExecutor Claude /v1/messages translation", () => {
  it("sends Fable 5 adaptive thinking without legacy budget_tokens", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream fixture", { status: 400 }));

    const exec = new GithubExecutor();
    const result = await exec.execute({
      model: "claude-fable-5",
      body: {
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      },
      stream: true,
      credentials: { copilotToken: "TOKEN" },
      signal: undefined,
      log: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/messages");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toEqual(result.transformedBody);
    expect(sentBody.output_config).toEqual({ effort: "high" });
    expect(sentBody.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sentBody.thinking).not.toHaveProperty("budget_tokens");
  });
});
