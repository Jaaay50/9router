import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn().mockResolvedValue([]),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  }),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((provider) => provider),
  FREE_PROVIDERS: {},
}));

vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
import { getModelLockUntil, isModelLockActive } from "../../open-sse/services/accountFallback.js";

const NOW = new Date("2026-07-31T03:00:00.000Z");
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000).toISOString();

function connection(id, fields = {}) {
  return {
    id,
    provider: "codex",
    isActive: true,
    accessToken: `TOKEN_${id}`,
    displayName: id,
    providerSpecificData: {},
    ...fields,
  };
}

describe("model lock isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    mocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the later relevant lock per connection and the earliest connection unlock", async () => {
    const connections = [
      connection("account-a", {
        modelLock_gpt: at(60),
        modelLock___all: at(120),
        modelLock_other: at(10),
        lastError: "old item_probe_a",
        errorCode: 400,
      }),
      connection("account-b", {
        modelLock_gpt: at(90),
        modelLock_other: at(300),
        lastError: "old item_probe_b",
        errorCode: 429,
      }),
    ];
    mocks.getProviderConnections.mockResolvedValue(connections);

    expect(getModelLockUntil(connections[0], "gpt")).toBe(at(120));
    expect(getModelLockUntil(connections[1], "gpt")).toBe(at(90));

    const result = await getProviderCredentials("codex", null, "gpt");

    expect(result).toEqual({
      allRateLimited: true,
      retryAfter: at(90),
      retryAfterHuman: "reset after 1m 30s",
    });
    expect(result).not.toHaveProperty("lastError");
    expect(result).not.toHaveProperty("lastErrorCode");
  });

  it("keeps an account locked when an expired model lock is shadowed by an active global lock", () => {
    const conn = connection("account-a", {
      modelLock_gpt: at(-10),
      modelLock___all: at(30),
    });

    expect(isModelLockActive(conn, "gpt")).toBe(true);
    expect(getModelLockUntil(conn, "gpt")).toBe(at(30));
  });

  it("ignores locks for other models when selecting the current model", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("account-a", {
        modelLock_other: at(300),
        lastError: "old item_probe_other",
      }),
    ]);

    const result = await getProviderCredentials("codex", null, "gpt");

    expect(result.connectionId).toBe("account-a");
    expect(result.accessToken).toBe("TOKEN_account-a");
  });

  it("does not write account state when the defensive marker receives a schema 400", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("account-a")]);
    const error = `[400]: ${JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "invalid_value",
        param: "input[434].id",
        message: "Expected an ID that begins with 'ctc' for input[434].id",
      },
    })}`;

    const result = await markAccountUnavailable("account-a", 400, error, "codex", "gpt");

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps rate-limit locking and fallback behavior unchanged", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("account-a", { backoffLevel: 0 })]);

    const result = await markAccountUnavailable("account-a", 429, "rate limit", "codex", "gpt");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 2000 });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("account-a", expect.objectContaining({
      modelLock_gpt: at(2),
      testStatus: "unavailable",
      errorCode: 429,
      backoffLevel: 1,
    }));
  });
});
