import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "open-sse/executors/index.js";
import { resolveRequestRoute } from "open-sse/services/provider.js";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";

function getHeader(headers, name) {
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

async function executeOpenAIRequest({ provider, model, credentials }) {
  const sourceBody = {
    model,
    stream: false,
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
  };
  const route = resolveRequestRoute(provider, model, FORMATS.OPENAI);
  const requestCredentials = {
    ...credentials,
    runtimeTransport: route.runtimeTransport,
    requestTargetFormat: route.targetFormat,
  };
  const translatedBody = translateRequest(
    FORMATS.OPENAI,
    route.targetFormat,
    model,
    structuredClone(sourceBody),
    false,
    requestCredentials,
    provider,
  );

  const result = await getExecutor(provider).execute({
    model,
    body: translatedBody,
    stream: false,
    credentials: requestCredentials,
  });
  const [url, options] = fetchMock.mock.calls.at(-1);

  return {
    route,
    result,
    url,
    headers: options.headers,
    body: JSON.parse(options.body),
  };
}

describe("request route resolution", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
    });
  });

  it("uses a model target format to select the matching transport atomically", () => {
    const route = resolveRequestRoute("minimax", "MiniMax-M3", FORMATS.OPENAI);

    expect(route.targetFormat).toBe(FORMATS.CLAUDE);
    expect(route.runtimeTransport?.format).toBe(FORMATS.CLAUDE);
    expect(route.runtimeTransport?.baseUrl).toContain("/anthropic/v1/messages");
  });

  it("uses the source-matched transport when the model has no override", () => {
    const openaiRoute = resolveRequestRoute("kimi", "kimi-k3", FORMATS.OPENAI);
    const claudeRoute = resolveRequestRoute("kimi", "kimi-k3", FORMATS.CLAUDE);

    expect(openaiRoute).toEqual(expect.objectContaining({ targetFormat: FORMATS.OPENAI }));
    expect(openaiRoute.runtimeTransport?.format).toBe(FORMATS.OPENAI);
    expect(claudeRoute).toEqual(expect.objectContaining({ targetFormat: FORMATS.CLAUDE }));
    expect(claudeRoute.runtimeTransport?.format).toBe(FORMATS.CLAUDE);
  });

  it("sends MiniMax M3 OpenAI input through the Claude endpoint and wire format", async () => {
    const outbound = await executeOpenAIRequest({
      provider: "minimax",
      model: "MiniMax-M3",
      credentials: { apiKey: "minimax-key" },
    });

    expect(outbound.route.targetFormat).toBe(FORMATS.CLAUDE);
    expect(outbound.url).toBe("https://api.minimax.io/anthropic/v1/messages?beta=true");
    expect(getHeader(outbound.headers, "x-api-key")).toBe("minimax-key");
    expect(getHeader(outbound.headers, "authorization")).toBeUndefined();
    expect(outbound.body).toEqual(expect.objectContaining({
      model: "MiniMax-M3",
      max_tokens: 256,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }));
  });

  it("sends Xiaomi's Claude-native model to the regional Claude endpoint", async () => {
    const outbound = await executeOpenAIRequest({
      provider: "xiaomi-tokenplan",
      model: "mimo-v2.5-pro-claude",
      credentials: {
        apiKey: "xiaomi-key",
        providerSpecificData: { region: "sgp" },
      },
    });

    expect(outbound.route.targetFormat).toBe(FORMATS.CLAUDE);
    expect(outbound.url).toBe("https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages");
    expect(getHeader(outbound.headers, "x-api-key")).toBe("xiaomi-key");
    expect(getHeader(outbound.headers, "authorization")).toBeUndefined();
    expect(outbound.body.messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "hello" }],
    }]);
  });

  it("keeps Kimi OpenAI input on the OpenAI endpoint and auth scheme", async () => {
    const outbound = await executeOpenAIRequest({
      provider: "kimi",
      model: "kimi-k3",
      credentials: {
        accessToken: "kimi-token",
        providerSpecificData: { deviceId: "device-fixture" },
      },
    });

    expect(outbound.route.targetFormat).toBe(FORMATS.OPENAI);
    expect(outbound.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(getHeader(outbound.headers, "authorization")).toBe("Bearer kimi-token");
    expect(getHeader(outbound.headers, "x-api-key")).toBeUndefined();
    expect(outbound.body).toEqual(expect.objectContaining({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(outbound.result.requestFormat).toBe(FORMATS.OPENAI);
  });
});
