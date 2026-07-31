import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyProviderError, isCodexRequestSchemaError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const ITEM_ID_ERROR = {
  type: "invalid_request_error",
  code: "invalid_value",
  param: "input[434].id",
  message: "Invalid 'input[434].id': 'item_probe_434'. Expected an ID that begins with 'ctc'.",
};

const log = { info: vi.fn(), warn: vi.fn() };

function errorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrappedSchemaResponse() {
  return errorResponse(400, {
    type: "invalid_request_error",
    code: "bad_request",
    message: `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}`,
  });
}

describe("Codex request schema classification", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["structured item ID", { error: ITEM_ID_ERROR }],
    ["raw JSON", JSON.stringify({ error: ITEM_ID_ERROR })],
    ["status-wrapped JSON", `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}`],
    ["outer bad_request wrapper", { error: { type: "invalid_request_error", code: "bad_request", message: `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}` } }],
    ["message-only item ID", `[400]: ${ITEM_ID_ERROR.message}`],
    ["unknown parameter", { error: { type: "invalid_request_error", code: "unknown_parameter", param: "input[2].namespace", message: "Unknown parameter" } }],
    ["message-only unknown parameter", "[400]: Unknown parameter: 'input[2].namespace'."],
    ["unsupported value", { error: { type: "invalid_request_error", code: "unsupported_value", param: "tool_choice", message: "Unsupported value" } }],
    ["message-only unsupported value", "[400]: Unsupported value for 'service_tier': 'BAD'."],
  ])("classifies %s", (_name, value) => {
    expect(classifyProviderError("codex", 400, value)).toEqual({
      category: "request_schema",
      accountFallback: false,
      cooldownMs: 0,
      comboScope: "provider",
    });
  });

  it.each([
    ["other provider", "openai", 400, { error: ITEM_ID_ERROR }],
    ["unauthorized", "codex", 401, { error: ITEM_ID_ERROR }],
    ["forbidden", "codex", 403, { error: ITEM_ID_ERROR }],
    ["rate limit", "codex", 429, "rate limit"],
    ["capacity", "codex", 400, "Selected model is at capacity"],
    ["invalid prompt", "codex", 400, { error: { type: "invalid_request_error", code: "invalid_prompt", message: ITEM_ID_ERROR.message } }],
    ["unsupported account model", "codex", 400, { error: { type: "invalid_request_error", code: "unsupported_value", param: "model", message: "This model is not supported for the current account" } }],
    ["unrelated invalid value", "codex", 400, { error: { type: "invalid_request_error", code: "invalid_value", param: "reasoning.effort", message: "Invalid value" } }],
  ])("does not classify %s", (_name, provider, status, value) => {
    expect(isCodexRequestSchemaError(provider, status, value)).toBe(false);
  });
});

describe("Codex provider-scoped Combo fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips remaining Codex models and continues another provider", async () => {
    const calls = [];
    const providers = {
      "cx/gpt-5.6-sol": "codex",
      "codex/gpt-5.5": "codex",
      "openai/gpt-5.5": "openai",
    };
    const response = await handleComboChat({
      body: {},
      models: Object.keys(providers),
      handleSingleModel: vi.fn(async (_body, model) => {
        calls.push(model);
        return model.startsWith("openai/") ? new Response("ok", { status: 200 }) : wrappedSchemaResponse();
      }),
      resolveModelProvider: async model => providers[model],
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["cx/gpt-5.6-sol", "openai/gpt-5.5"]);
  });

  it("returns the first schema 400 after one all-Codex call", async () => {
    const first = wrappedSchemaResponse();
    const handleSingleModel = vi.fn().mockResolvedValue(first);
    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5"],
      handleSingleModel,
      resolveModelProvider: async () => "codex",
      log,
      autoSwitch: false,
    });

    expect(response).toBe(first);
    expect(handleSingleModel).toHaveBeenCalledOnce();
  });

  it.each([429, 502, 503, 504])("keeps normal fallback for HTTP %s", async status => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(errorResponse(status, { message: status === 429 ? "rate limit" : "upstream unavailable" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5"],
      handleSingleModel,
      resolveModelProvider: async () => "codex",
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
