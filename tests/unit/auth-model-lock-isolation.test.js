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

import { markAccountUnavailable } from "../../src/sse/services/auth.js";

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

describe("account fallback isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    mocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

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
