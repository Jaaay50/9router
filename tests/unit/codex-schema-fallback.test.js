import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyProviderError, isCodexRequestSchemaError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { createErrorResult } from "../../open-sse/utils/error.js";

const ITEM_ID_ERROR = {
  type: "invalid_request_error",
  code: "invalid_value",
  param: "input[434].id",
  message: "Invalid 'input[434].id': 'item_probe_434'. Expected an ID that begins with 'ctc'.",
};

const SCREENSHOT_ITEM_ID_ERROR = {
  type: "invalid_request_error",
  code: "invalid_value",
  param: "input[58].id",
  message: "Invalid 'input[58].id': 'item_8e297850f5942c40d91db6c2'. Expected an ID that begins with 'ctc'.",
};
const SCREENSHOT_WRAPPED_ERROR = `[codex/gpt-5.6-sol] [400]: ${JSON.stringify({
  error: SCREENSHOT_ITEM_ID_ERROR,
})} (reset after 19s)`;

const log = { info: vi.fn(), warn: vi.fn() };

function jsonErrorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrappedSchemaResponse() {
  return jsonErrorResponse(400, {
    message: `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}`,
    type: "invalid_request_error",
    code: "bad_request",
  });
}

function wrappedMessageOnlySchemaResponse() {
  return jsonErrorResponse(400, {
    message: "[400]: Unknown parameter: input[150].namespace",
    type: "invalid_request_error",
    code: "bad_request",
  });
}

describe("Codex request schema classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["structured error", { error: ITEM_ID_ERROR }],
    ["screenshot input[58] error", { error: SCREENSHOT_ITEM_ID_ERROR }],
    ["full screenshot wrapper with stale reset suffix", SCREENSHOT_WRAPPED_ERROR],
    ["raw JSON", JSON.stringify({ error: ITEM_ID_ERROR })],
    ["status wrapped JSON", `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}`],
    ["outer response wrapper", { error: { message: `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}`, type: "invalid_request_error", code: "bad_request" } }],
    ["message-only item error", `[400]: ${ITEM_ID_ERROR.message}`],
    ["unknown_parameter", { error: { type: "invalid_request_error", code: "unknown_parameter", message: "Unknown parameter: 'input[2].namespace'." } }],
    ["top-level unknown_parameter", { error: { type: "invalid_request_error", code: "unknown_parameter", param: "parallel_tool_calls", message: "Unknown parameter: 'parallel_tool_calls'." } }],
    ["structured unknown_parameter alternate wording", { error: { type: "invalid_request_error", code: "unknown_parameter", param: "stream", message: "This request option is not recognized." } }],
    ["unsupported_value", { error: { type: "invalid_request_error", code: "unsupported_value", message: "Unsupported value for 'input[2].type'." } }],
    ["top-level tool_choice unsupported_value", { error: { type: "invalid_request_error", code: "unsupported_value", param: "tool_choice", message: "Unsupported value for 'tool_choice': 'BAD'." } }],
    ["top-level service_tier unsupported_value", { error: { type: "invalid_request_error", code: "unsupported_value", param: "service_tier", message: "Unsupported value for 'service_tier': 'BAD'." } }],
    ["top-level prompt_cache_key unsupported_value", { error: { type: "invalid_request_error", code: "unsupported_value", param: "prompt_cache_key", message: "Unsupported value for 'prompt_cache_key': 'BAD'." } }],
    ["top-level client_metadata unsupported_value", { error: { type: "invalid_request_error", code: "unsupported_value", param: "client_metadata", message: "Unsupported value for 'client_metadata': 'BAD'." } }],
    ["structured unsupported_value alternate wording", { error: { type: "invalid_request_error", code: "unsupported_value", param: "client_metadata", message: "This request option is invalid." } }],
    ["message-only unknown_parameter", "[400]: Unknown parameter: 'input[150].namespace'."],
    ["message-only unsupported_value", "[400]: Unsupported value for 'input[2].type'."],
    ["message-only top-level unsupported_value", "[400]: Unsupported value for 'tool_choice': 'BAD'."],
  ])("classifies %s as a provider-scoped request schema error", (_name, value) => {
    expect(classifyProviderError("codex", 400, value)).toEqual({
      category: "request_schema",
      accountFallback: false,
      cooldownMs: 0,
      comboScope: "provider",
    });
  });

  it("classifies the real createErrorResult wrapper used by chatCore", () => {
    const result = createErrorResult(400, `[400]: ${JSON.stringify({ error: {
      type: "invalid_request_error",
      code: "unsupported_value",
      param: "tool_choice",
      message: "Unsupported value for 'tool_choice': 'BAD'.",
    } })}`);

    expect(classifyProviderError("codex", result.status, result.error)).toEqual({
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
    ["invalid_prompt", "codex", 400, { error: { type: "invalid_request_error", code: "invalid_prompt", message: "Unknown parameter in the prompt" } }],
    ["invalid_prompt wrapping schema JSON", "codex", 400, { error: { type: "invalid_request_error", code: "invalid_prompt", message: `[400]: ${JSON.stringify({ error: ITEM_ID_ERROR })}` } }],
    ["generic wrapper around invalid_prompt", "codex", 400, { error: { type: "invalid_request_error", code: "bad_request", message: `[400]: ${JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_prompt", message: "Unknown parameter in prompt" } })}` } }],
    ["top-level invalid_prompt with error string", "codex", 400, { type: "invalid_request_error", code: "invalid_prompt", error: "Unknown parameter: 'input[2].namespace'." }],
    ["top-level invalid_prompt with item param", "codex", 400, { type: "invalid_request_error", code: "invalid_prompt", param: "input[4].id", error: "Expected an ID that begins with 'ctc'" }],
    ["message-only invalid_prompt wording", "codex", 400, "Unknown parameter in the prompt"],
    ["message-only unsupported account value", "codex", 400, "Unsupported value for the current account"],
    ["unsupported account model", "codex", 400, "The model is not supported when using Codex with a ChatGPT account."],
    ["structured unsupported account model", "codex", 400, { error: { type: "invalid_request_error", code: "unsupported_value", param: "model", message: "Unsupported value for model: this model is not supported when using Codex with a ChatGPT account." } }],
    ["generic model unsupported_value", "codex", 400, { error: { type: "invalid_request_error", code: "unsupported_value", param: "model", message: "Unsupported value for 'model': 'BAD'." } }],
    ["account model unknown_parameter", "codex", 400, { error: { type: "invalid_request_error", code: "unknown_parameter", param: "model", message: "Unknown parameter: 'model'. This model is not supported for the current account." } }],
    ["unrelated invalid_value", "codex", 400, { error: { type: "invalid_request_error", code: "invalid_value", param: "reasoning.effort", message: "Invalid value: xhigh" } }],
    ["non-ID prefix message", "codex", 400, { error: { type: "invalid_request_error", code: "invalid_value", param: "input[4].id", message: "Invalid item ID" } }],
  ])("does not classify %s", (_name, provider, status, value) => {
    expect(isCodexRequestSchemaError(provider, status, value)).toBe(false);
  });

  it("blocks the remaining Codex provider models but continues a heterogeneous combo", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      if (model === "openai/gpt-5.5") return new Response("ok", { status: 200 });
      return wrappedSchemaResponse();
    });

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5", "openai/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["cx/gpt-5.6-sol", "openai/gpt-5.5"]);
  });

  it("returns the first original 400 after an all-Codex combo makes one upstream call", async () => {
    const firstResponse = wrappedSchemaResponse();
    const handleSingleModel = vi.fn().mockResolvedValue(firstResponse);

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5", "cx/gpt-5.4"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("keeps message-only schema errors provider-scoped after chat wrapping", async () => {
    const firstResponse = wrappedMessageOnlySchemaResponse();
    const handleSingleModel = vi.fn().mockResolvedValue(firstResponse);

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("keeps createErrorResult schema errors provider-scoped in an all-Codex combo", async () => {
    const firstResult = createErrorResult(400, `[400]: ${JSON.stringify({ error: {
      type: "invalid_request_error",
      code: "unsupported_value",
      param: "service_tier",
      message: "Unsupported value for 'service_tier': 'BAD'.",
    } })}`);
    const handleSingleModel = vi.fn().mockResolvedValue(firstResult.response);

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResult.response);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("uses canonical alias resolution for provider-scoped Combo blocking", async () => {
    const calls = [];
    const providers = {
      "codex-primary": "codex",
      "codex-secondary": "codex",
      "openai-backup": "openai",
    };
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return model === "openai-backup" ? new Response("ok", { status: 200 }) : wrappedSchemaResponse();
    });

    const response = await handleComboChat({
      body: {},
      models: ["codex-primary", "codex-secondary", "openai-backup"],
      handleSingleModel,
      resolveModelProvider: async (model) => providers[model],
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["codex-primary", "openai-backup"]);
  });

  it("returns the first Codex schema error when other providers are also unavailable", async () => {
    const firstResponse = wrappedSchemaResponse();
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(jsonErrorResponse(429, { message: "rate limit" }));

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "openai/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response).toBe(firstResponse);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, { message: "rate limit" }],
    [502, { message: "bad gateway" }],
    [503, { message: "service unavailable" }],
    [504, { message: "gateway timeout" }],
    [400, { type: "invalid_request_error", code: "invalid_prompt", message: "Prompt is too long" }],
  ])("keeps existing Codex model fallback for status %s", async (status, error) => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(jsonErrorResponse(status, error))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "codex/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("keeps the first failure status when every normal fallback attempt fails", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(jsonErrorResponse(429, { message: "rate limit" }))
      .mockResolvedValueOnce(jsonErrorResponse(503, { message: "service unavailable" }));

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol", "openai/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(429);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("preserves Retry-After when a combo model was already account-locked", async () => {
    const locked = new Response(JSON.stringify({ error: { message: "Temporarily unavailable" } }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });

    const response = await handleComboChat({
      body: {},
      models: ["cx/gpt-5.6-sol"],
      handleSingleModel: vi.fn().mockResolvedValue(locked),
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(59);
    expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
  });

  it("contains malformed combo entries inside normal fallback handling", async () => {
    const handleSingleModel = vi.fn()
      .mockRejectedValueOnce(new Error("invalid combo model"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: {},
      models: [{ provider: "codex" }, "openai/gpt-5.5"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
