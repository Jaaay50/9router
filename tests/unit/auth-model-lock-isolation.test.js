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
  resolveProviderId: vi.fn(provider => provider),
  FREE_PROVIDERS: {},
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }));

import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
import { getModelLockUntil, isModelLockActive } from "../../open-sse/services/accountFallback.js";

const NOW = new Date("2026-07-31T03:00:00.000Z");
const at = seconds => new Date(NOW.getTime() + seconds * 1000).toISOString();

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

  afterEach(() => vi.useRealTimers());

  it("uses only the requested model and global locks for retry timing", async () => {
    const connections = [
      connection("account-a", {
        modelLock_gpt: at(60),
        modelLock___all: at(120),
        modelLock_other: at(10),
        lastError: "old item_probe_a",
      }),
      connection("account-b", {
        modelLock_gpt: at(90),
        modelLock_other: at(300),
        lastError: "old item_probe_b",
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
  });

  it("does not let an expired model lock hide an active global lock", () => {
    const account = connection("account-a", {
      modelLock_gpt: at(-10),
      modelLock___all: at(30),
    });
    expect(isModelLockActive(account, "gpt")).toBe(true);
    expect(getModelLockUntil(account, "gpt")).toBe(at(30));
  });

  it("ignores another model's lock", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("account-a", { modelLock_other: at(300), lastError: "old item_probe_other" }),
    ]);
    const result = await getProviderCredentials("codex", null, "gpt");
    expect(result.connectionId).toBe("account-a");
  });

  it("rejects schema errors before DB reads even with a future reset timestamp", async () => {
    const error = `[400]: ${JSON.stringify({ error: {
      type: "invalid_request_error",
      code: "invalid_value",
      param: "input[58].id",
      message: "Expected an ID that begins with 'ctc' for input[58].id",
    } })}`;
    const result = await markAccountUnavailable(
      "account-a", 400, error, "codex", "gpt", NOW.getTime() + 30000,
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps rate-limit locking unchanged", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("account-a", { backoffLevel: 0 })]);
    const result = await markAccountUnavailable("account-a", 429, "rate limit", "codex", "gpt");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 2000 });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("account-a", expect.objectContaining({
      modelLock_gpt: at(2),
      errorCode: 429,
      backoffLevel: 1,
    }));
  });
});
