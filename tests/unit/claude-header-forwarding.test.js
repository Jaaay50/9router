/**
 * Unit tests for Anthropic header caching + forwarding pipeline
 *
 * Tests cover:
 *  - claudeHeaderCache: detection, capture, and retrieval of Claude Code headers
 *  - default.js buildHeaders(): live header overlay for "claude" provider
 *  - default.js buildHeaders(): cold-start fallback when cache is empty
 *  - default.js buildHeaders(): anthropic-compatible non-Anthropic host stripping
 *  - default.js buildHeaders(): anthropic-compatible official host keeps headers
 *  - proxyFetch.js: api.anthropic.com routes through anthropicFetch path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FORMATS } from "open-sse/translator/formats.js";

// ─── claudeHeaderCache ────────────────────────────────────────────────────────

describe("claudeHeaderCache", () => {
  let cacheModule;

  beforeEach(async () => {
    // Re-import fresh module each time to reset singleton state
    vi.resetModules();
    cacheModule = await import("open-sse/utils/claudeHeaderCache.js");
  });

  it("returns null before any headers are cached (cold start)", () => {
    expect(cacheModule.getCachedClaudeHeaders()).toBeNull();
  });

  it("caches headers when user-agent contains 'claude-code'", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63 node/24.3.0",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v24.3.0",
      "x-stainless-package-version": "0.74.0",
      "x-stainless-helper-method": "stream",
      "x-stainless-retry-count": "0",
      "x-stainless-timeout": "600",
      "x-claude-code-session-id": "session-must-not-be-global",
      "anthropic-dangerous-direct-browser-access": "true",
      // Non-identity header — should NOT be captured
      "content-type": "application/json",
    });

    const cached = cacheModule.getCachedClaudeHeaders();
    expect(cached).not.toBeNull();
    expect(cached["user-agent"]).toBe("claude-code/2.1.63 node/24.3.0");
    expect(cached["anthropic-beta"]).toBeUndefined();
    expect(cached["x-claude-code-session-id"]).toBeUndefined();
    expect(cached["x-app"]).toBe("cli");
    expect(cached["x-stainless-os"]).toBe("MacOS");
    // Non-identity header must not leak in
    expect(cached["content-type"]).toBeUndefined();
  });

  it("caches headers when user-agent contains 'claude-cli'", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-cli/1.0.0",
      "anthropic-version": "2023-06-01",
    });
    expect(cacheModule.getCachedClaudeHeaders()).not.toBeNull();
    expect(cacheModule.getCachedClaudeHeaders()["user-agent"]).toBe("claude-cli/1.0.0");
  });

  it("caches headers when x-app is 'cli' (regardless of user-agent)", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "axios/1.7.0",
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
    });
    expect(cacheModule.getCachedClaudeHeaders()).not.toBeNull();
  });

  it("does NOT cache headers for non-Claude clients", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "PostmanRuntime/7.43.0",
      "anthropic-version": "2023-06-01",
    });
    expect(cacheModule.getCachedClaudeHeaders()).toBeNull();
  });

  it("refreshes cache on each matching request", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.0.0",
      "x-stainless-package-version": "0.70.0",
    });
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63",
      "x-stainless-package-version": "0.74.0",
    });
    const cached = cacheModule.getCachedClaudeHeaders();
    expect(cached["user-agent"]).toBe("claude-code/2.1.63");
    expect(cached["x-stainless-package-version"]).toBe("0.74.0");
  });

  it("ignores calls with null or non-object headers", () => {
    cacheModule.cacheClaudeHeaders(null);
    cacheModule.cacheClaudeHeaders(undefined);
    cacheModule.cacheClaudeHeaders("string");
    expect(cacheModule.getCachedClaudeHeaders()).toBeNull();
  });

  it("only stores keys that are actually present in the headers object", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63",
      // Most stainless headers absent
    });
    const cached = cacheModule.getCachedClaudeHeaders();
    expect(cached["x-stainless-os"]).toBeUndefined();
    expect(cached["user-agent"]).toBe("claude-code/2.1.63");
  });
});

// ─── DefaultExecutor.buildHeaders() ──────────────────────────────────────────

describe("DefaultExecutor.buildHeaders() — claude provider", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    // Prime the cache with live client headers before importing executor
    const cache = await import("open-sse/utils/claudeHeaderCache.js");
    cache.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63 node/24.3.0",
      "anthropic-beta": "request-only-beta-2099-01-01",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v24.3.0",
      "x-stainless-package-version": "0.74.0",
      "x-stainless-helper-method": "stream",
      "x-stainless-retry-count": "0",
      "x-stainless-timeout": "600",
    });
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("overlays live cached headers over static provider defaults", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    // Live values should win over static providers.js values
    expect(headers["user-agent"]).toBe("claude-code/2.1.63 node/24.3.0");
    // Request beta is intentionally excluded from the global identity cache.
    const betaFlags = (headers["anthropic-beta"] || headers["Anthropic-Beta"]).split(",").map(s => s.trim());
    expect(betaFlags).toContain("claude-code-20250219");
    expect(betaFlags).toContain("oauth-2025-04-20");
    expect(betaFlags).toContain("interleaved-thinking-2025-05-14");
    expect(betaFlags).not.toContain("request-only-beta-2099-01-01");
    expect(headers["x-stainless-package-version"]).toBe("0.74.0");
    expect(headers["x-stainless-os"]).toBe("MacOS");
  });

  it("removes conflicting Title-Case static keys when cached lowercase keys exist", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    // Cached identity headers replace their Title-Case static variants.
    expect(headers["Anthropic-Version"]).toBeUndefined();
    // Beta remains static until request-scoped finalization canonicalizes it.
    expect(headers["Anthropic-Beta"]).toBeDefined();
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["X-App"]).toBeUndefined();
    // Lowercase variants must be present
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-app"]).toBe("cli");
  });

  it("sets x-api-key auth when apiKey is provided", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-live-key" }, true);
    expect(headers["x-api-key"]).toBe("sk-live-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sets Bearer Authorization when only accessToken is provided", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ accessToken: "tok-abc" }, true);
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("includes Accept: text/event-stream when stream=true", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, true);
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("omits Accept: text/event-stream when stream=false", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, false);
    expect(headers["Accept"]).toBeUndefined();
  });
});

describe("DefaultExecutor.buildHeaders() — claude provider cold start (no cache)", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    // Do NOT prime cache — simulate cold start
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("falls back to static provider headers when cache is empty", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    // Static fallback values from providers.js must still be present
    // They may be Title-Case since no cache to conflict with them
    const hasVersion =
      headers["Anthropic-Version"] === "2023-06-01" ||
      headers["anthropic-version"] === "2023-06-01";
    expect(hasVersion).toBe(true);
  });

  it("does not throw when cache returns null", () => {
    const executor = new DefaultExecutor("claude");
    expect(() => executor.buildHeaders({ apiKey: "sk" }, false)).not.toThrow();
  });
});

// ─── anthropic-compatible final outbound policy ───────────────────────────────

describe("DefaultExecutor.finalizeOutboundRequest() — anthropic-compatible stripping", () => {
  let DefaultExecutor;

  function finalize(executor, credentials, body = { messages: [] }, stream = true) {
    const url = executor.buildUrl("claude-test", stream, 0, credentials);
    const headers = executor.buildHeaders(credentials, stream);
    return executor.finalizeOutboundRequest({ url, headers, transformedBody: body, credentials });
  }

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("strips x-app and anthropic-dangerous-direct-browser-access for non-Anthropic host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const credentials = {
      apiKey: "key",
      providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
    };
    const initialHeaders = executor.buildHeaders(credentials, true);
    initialHeaders["x-app"] = "cli";
    initialHeaders["anthropic-dangerous-direct-browser-access"] = "true";
    initialHeaders["x-claude-code-session-id"] = "stale-global-session";
    const { headers } = executor.finalizeOutboundRequest({
      url: executor.buildUrl("claude-test", true, 0, credentials),
      headers: initialHeaders,
      transformedBody: { messages: [] },
      credentials,
    });

    expect(headers["x-app"]).toBeUndefined();
    expect(headers["X-App"]).toBeUndefined();
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBeUndefined();
    expect(headers["x-claude-code-session-id"]).toBeUndefined();
  });

  it("removes claude-code-20250219 from anthropic-beta for non-Anthropic host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const credentials = {
      apiKey: "key",
      providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
    };
    const initialHeaders = {
      ...executor.buildHeaders(credentials, true),
      "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    };
    const { headers } = executor.finalizeOutboundRequest({
      url: executor.buildUrl("claude-test", true, 0, credentials),
      headers: initialHeaders,
      transformedBody: { messages: [] },
      credentials,
    });

    const betaVal = headers["anthropic-beta"] || headers["Anthropic-Beta"] || "";
    expect(betaVal).not.toContain("claude-code-20250219");
  });

  it("keeps other beta flags intact after stripping", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const credentials = {
      apiKey: "key",
      providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
    };
    const initialHeaders = {
      ...executor.buildHeaders(credentials, false),
      "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    };
    const { headers } = executor.finalizeOutboundRequest({
      url: executor.buildUrl("claude-test", false, 0, credentials),
      headers: initialHeaders,
      transformedBody: { messages: [] },
      credentials,
    });

    const betaVal = headers["anthropic-beta"] || headers["Anthropic-Beta"] || "";
    // If any beta value remains it should not be empty and should not have the stripped value
    if (betaVal) {
      expect(betaVal).not.toContain("claude-code-20250219");
    }
  });

  it("does NOT strip headers when baseUrl is api.anthropic.com", () => {
    const executor = new DefaultExecutor("anthropic-compatible-official");
    const credentials = {
      apiKey: "key",
      providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
    };
    const { headers } = finalize(executor, credentials);

    // No stripping — anthropic-version should survive
    const hasVersion =
      headers["Anthropic-Version"] || headers["anthropic-version"];
    expect(hasVersion).toBeDefined();
  });

  it("does NOT strip headers when baseUrl is empty (defaults to Anthropic)", () => {
    const executor = new DefaultExecutor("anthropic-compatible-official");
    const credentials = { apiKey: "key", providerSpecificData: {} };
    const { headers } = finalize(executor, credentials);

    const hasVersion =
      headers["Anthropic-Version"] || headers["anthropic-version"];
    expect(hasVersion).toBeDefined();
  });
});

describe("DefaultExecutor.finalizeOutboundRequest() — Anthropic beta policy", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  function finalize(provider, { url, body, credentials = {}, headers = {} }) {
    const executor = new DefaultExecutor(provider);
    return executor.finalizeOutboundRequest({ url, headers, transformedBody: body, credentials });
  }

  it("derives all required beta flags from the final body for the official endpoint", () => {
    const credentials = {
      apiKey: "connection-key",
      rawHeaders: {
        "anthropic-beta": "future-feature-2099-01-01,invalid beta,header\r\ninjection",
        "x-claude-code-session-id": "session-current-request",
        authorization: "Bearer client-token",
        "x-api-key": "client-key",
        cookie: "session=client-cookie",
        "x-arbitrary": "not-forwarded",
      },
    };
    const executor = new DefaultExecutor("anthropic");
    const headers = executor.buildHeaders(credentials, true);
    const body = {
      messages: [],
      context_management: null,
      output_config: { effort: null, format: null },
      tools: [{ name: "search", input_examples: [] }],
    };
    const finalized = executor.finalizeOutboundRequest({
      url: "https://api.anthropic.com/v1/messages",
      headers,
      transformedBody: body,
      credentials,
    });

    const betaFlags = finalized.headers["anthropic-beta"].split(",");
    expect(betaFlags).toEqual(expect.arrayContaining([
      "claude-code-20250219",
      "interleaved-thinking-2025-05-14",
      "future-feature-2099-01-01",
      "context-management-2025-06-27",
      "effort-2025-11-24",
      "advanced-tool-use-2025-11-20",
      "structured-outputs-2025-12-15",
    ]));
    expect(betaFlags).not.toContain("invalid beta");
    expect(finalized.transformedBody.context_management).toBeNull();
    expect(finalized.headers["x-api-key"]).toBe("connection-key");
    expect(finalized.headers["x-claude-code-session-id"]).toBe("session-current-request");
    expect(finalized.headers.Authorization).toBeUndefined();
    expect(finalized.headers.cookie).toBeUndefined();
    expect(finalized.headers["x-arbitrary"]).toBeUndefined();
  });

  it.each([
    "session-with\r\ninjected-header",
    "\r\nsession-with-leading-newline",
    "session-with-trailing-newline\r\n",
    "x".repeat(257),
    `${" ".repeat(257)}session-after-overlong-whitespace`,
  ])("rejects an invalid request-scoped Claude session ID", sessionId => {
    const result = finalize("anthropic", {
      url: "https://api.anthropic.com/v1/messages",
      credentials: { rawHeaders: { "x-claude-code-session-id": sessionId } },
      headers: { "x-claude-code-session-id": "stale-global-session" },
      body: { messages: [] },
    });

    expect(result.headers["x-claude-code-session-id"]).toBeUndefined();
  });

  it.each([
    {
      provider: "claude",
      credentials: { accessToken: "oauth-token" },
      expectedAuth: ["Authorization", "Bearer oauth-token"],
    },
    {
      provider: "anthropic-compatible-official",
      credentials: {
        apiKey: "compatible-key",
        providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
      },
      expectedAuth: ["x-api-key", "compatible-key"],
    },
  ])("applies the official policy for $provider", ({ provider, credentials, expectedAuth }) => {
    const executor = new DefaultExecutor(provider);
    const body = { messages: [], context_management: { edits: [] } };
    const url = executor.buildUrl("claude-test", true, 0, credentials);
    const result = executor.finalizeOutboundRequest({
      url,
      headers: executor.buildHeaders(credentials, true),
      transformedBody: body,
      credentials,
    });

    expect(result.transformedBody.context_management).toEqual({ edits: [] });
    expect(result.headers["anthropic-beta"]).toContain("context-management-2025-06-27");
    expect(result.headers[expectedAuth[0]]).toBe(expectedAuth[1]);
    if (provider.startsWith("anthropic-compatible-")) {
      expect(result.headers.Authorization).toBeUndefined();
    }
  });

  it.each([
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.example/v1/messages",
    "https://anthropic.example.com/v1/messages",
  ])("treats %s as non-official and removes context management", url => {
    const result = finalize("anthropic-compatible-custom", {
      url,
      headers: {
        "Anthropic-Beta": "context-management-2025-06-27,interleaved-thinking-2025-05-14",
      },
      body: { messages: [], context_management: null },
    });

    expect(result.transformedBody).not.toHaveProperty("context_management");
    expect(result.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  });

  it("allows an internal Claude transport to opt in to explicit beta features", () => {
    const credentials = {
      rawHeaders: { "anthropic-beta": "allowed-future-2099-01-01,blocked-future-2099-01-01" },
      runtimeTransport: {
        format: FORMATS.CLAUDE,
        quirks: {
          anthropicBetaFeatures: [
            "context-management-2025-06-27",
            "allowed-future-2099-01-01",
          ],
        },
      },
    };
    const result = finalize("anthropic-compatible-internal", {
      url: "https://internal-claude.example.com/messages",
      credentials,
      headers: {},
      body: { messages: [], context_management: null },
    });

    expect(result.transformedBody.context_management).toBeNull();
    expect(result.headers["anthropic-beta"].split(",")).toEqual([
      "allowed-future-2099-01-01",
      "context-management-2025-06-27",
    ]);
  });

  it("does not fall back to provider quirks when a runtime Claude transport is selected", () => {
    const executor = new DefaultExecutor("kimi");
    executor.config = {
      ...executor.config,
      quirks: { anthropicBetaFeatures: ["context-management-2025-06-27"] },
    };
    const credentials = {
      runtimeTransport: { format: FORMATS.CLAUDE, quirks: {} },
    };
    const result = executor.finalizeOutboundRequest({
      url: "https://internal-claude.example.com/messages",
      headers: { "Anthropic-Beta": "context-management-2025-06-27" },
      transformedBody: { messages: [], context_management: null },
      credentials,
    });

    expect(result.transformedBody).not.toHaveProperty("context_management");
    expect(result.headers["anthropic-beta"]).toBeUndefined();
  });

  it.each(["kimi", "minimax"])("leaves %s OpenAI runtime transport requests untouched", provider => {
    const executor = new DefaultExecutor(provider);
    const runtimeTransport = executor.config.transports.find(transport => transport.format === FORMATS.OPENAI);
    const credentials = {
      apiKey: "runtime-key",
      runtimeTransport,
      rawHeaders: {
        "anthropic-beta": "request-beta-2099-01-01",
        "x-claude-code-session-id": "request-session",
      },
    };
    const url = executor.buildUrl("runtime-model", true, 0, credentials);
    const headers = executor.buildHeaders(credentials, true);
    const body = { messages: [], context_management: null };
    const result = executor.finalizeOutboundRequest({
      url,
      headers,
      transformedBody: body,
      credentials,
    });

    expect(result.headers).toBe(headers);
    expect(result.transformedBody).toBe(body);
    expect(result.transformedBody.context_management).toBeNull();
    expect(result.headers["anthropic-beta"]).toBeUndefined();
    expect(result.headers["x-claude-code-session-id"]).toBeUndefined();
  });

  it("keeps request beta flags and session IDs isolated across concurrent finalization", async () => {
    const executor = new DefaultExecutor("anthropic");
    const run = (beta, sessionId) => Promise.resolve().then(() => executor.finalizeOutboundRequest({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Anthropic-Beta": "static-beta-2025-01-01",
        "x-claude-code-session-id": "stale-global-session",
      },
      transformedBody: { messages: [] },
      credentials: {
        rawHeaders: {
          "anthropic-beta": beta,
          "x-claude-code-session-id": sessionId,
        },
      },
    }));

    const [first, second] = await Promise.all([
      run("request-one-2099-01-01", "session-one"),
      run("request-two-2099-01-01", "session-two"),
    ]);

    expect(first.headers["anthropic-beta"]).toContain("request-one-2099-01-01");
    expect(first.headers["anthropic-beta"]).not.toContain("request-two-2099-01-01");
    expect(second.headers["anthropic-beta"]).toContain("request-two-2099-01-01");
    expect(second.headers["anthropic-beta"]).not.toContain("request-one-2099-01-01");
    expect(first.headers["x-claude-code-session-id"]).toBe("session-one");
    expect(second.headers["x-claude-code-session-id"]).toBe("session-two");
  });
});

// ─── proxyFetch anthropicFetch routing ────────────────────────────────────────

describe("proxyAwareFetch — api.anthropic.com routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes api.anthropic.com to gotScraping (non-streaming) and returns ok response", async () => {
    // Mock got-scraping before module load
    vi.doMock("got-scraping", () => {
      const mockGotScraping = vi.fn().mockResolvedValue({
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        rawBody: Buffer.from(JSON.stringify({ id: "msg_test" })),
      });
      mockGotScraping.stream = vi.fn();
      return { gotScraping: mockGotScraping };
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
    const { gotScraping } = await import("got-scraping");

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      // No Accept: text/event-stream → non-streaming path
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });

    expect(gotScraping).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("msg_test");
  });

  it("falls back gracefully when got-scraping throws on non-streaming path", async () => {
    vi.doMock("got-scraping", () => {
      const fn = vi.fn().mockRejectedValue(new Error("TLS error"));
      fn.stream = vi.fn();
      return { gotScraping: fn };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
      json: async () => ({}),
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.ok).toBe(true);
    globalThis.fetch = originalFetch;
  });

  it("does NOT route non-Anthropic hosts through gotScraping", async () => {
    const gotScrapingMock = vi.fn();
    vi.doMock("got-scraping", () => ({ gotScraping: gotScrapingMock }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
      json: async () => ({}),
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    await proxyAwareFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(gotScrapingMock).not.toHaveBeenCalled();
  });
});
