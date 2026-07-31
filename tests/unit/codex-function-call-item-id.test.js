import { describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function transformBody(input, overrides = {}) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.6-sol",
    input,
    stream: true,
    ...overrides,
  };

  const transformed = executor.transformRequest("gpt-5.6-sol", body, true, {
    connectionId: "test-codex-stateless-item-id",
    providerSpecificData: {},
  });

  return { source: body, transformed };
}

function transformInput(input) {
  return transformBody(input).transformed.input;
}

const TARGET_ITEMS = {
  function_call: {
    legalId: "fc_valid_1",
    payload: { call_id: "call_function", name: "shell", arguments: "{\"cmd\":\"pwd\"}", status: "completed" },
  },
  function_call_output: {
    legalId: "fco_valid_1",
    payload: { call_id: "call_function", output: "done", status: "completed" },
  },
  custom_tool_call: {
    legalId: "ctc_valid_1",
    payload: { call_id: "call_custom", name: "codex_app", input: "PAYLOAD", status: "completed" },
  },
  custom_tool_call_output: {
    legalId: "ctco_valid_1",
    payload: { call_id: "call_custom", output: "RESULT", status: "completed" },
  },
};

describe("CodexExecutor stateless item IDs", () => {
  it.each(Object.entries(TARGET_ITEMS))("removes every optional %s id and preserves its payload", (type, fixture) => {
    const ids = ["item_replayed_1", fixture.legalId, 42, null];
    const source = [
      ...ids.map((id, index) => ({ type, id, ...fixture.payload, sequence: index })),
      { type, ...fixture.payload, sequence: ids.length },
    ];
    const snapshot = structuredClone(source);

    const input = transformInput(source);

    expect(input).toHaveLength(source.length);
    input.forEach((item, index) => {
      expect(item).toEqual({ type, ...fixture.payload, sequence: index });
    });
    expect(source).toEqual(snapshot);
    expect(source.slice(0, ids.length).map((item) => item.id)).toEqual(ids);
  });

  it("preserves typed message and reasoning IDs plus encrypted reasoning content", () => {
    const input = transformInput([
      {
        type: "message",
        id: "msg_history_1",
        role: "assistant",
        content: [{ type: "output_text", text: "continue" }],
      },
      {
        type: "reasoning",
        id: "rs_history_1",
        encrypted_content: "ENCRYPTED_REASONING",
        summary: [{ type: "summary_text", text: "summary" }],
      },
    ]);

    expect(input[0].id).toBe("msg_history_1");
    expect(input[1]).toEqual({
      type: "reasoning",
      id: "rs_history_1",
      encrypted_content: "ENCRYPTED_REASONING",
      summary: [{ type: "summary_text", text: "summary" }],
    });
  });

  it("preserves every non-tool item ID without applying generic prefix validation", () => {
    const fixtures = [
      ["additional_tools", "at", { tools: [] }],
      ["message", "msg", { role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      ["agent_message", "amsg", { content: "ok" }],
      ["reasoning", "rs", { encrypted_content: "ENCRYPTED_REASONING" }],
      ["local_shell_call", "lsh", { call_id: "call_shell", action: { command: ["pwd"] } }],
      ["tool_search_call", "tsc", { call_id: "call_search", arguments: "{}" }],
      ["tool_search_output", "tso", { call_id: "call_search", output: "RESULT" }],
      ["web_search_call", "ws", { call_id: "call_web", action: { type: "search" } }],
      ["image_generation_call", "ig", { call_id: "call_image", result: "IMAGE" }],
      ["compaction", "cmp", { encrypted_content: "COMPACTED" }],
      ["context_compaction", "cmp", { encrypted_content: "CONTEXT_COMPACTED" }],
    ];
    const source = fixtures.flatMap(([type, prefix, payload]) => [
      { type, id: `${prefix}_valid_1`, ...payload },
      { type, id: "item_replayed_1", ...payload },
      { type, id: "wrong_prefix_1", ...payload },
      { type, id: 42, ...payload },
      { type, id: null, ...payload },
    ]);
    const snapshot = structuredClone(source);

    const input = transformInput(source);

    expect(input).toEqual(source);
    expect(source).toEqual(snapshot);
  });

  it("preserves implicit message IDs when the item only has a role", () => {
    const input = transformInput([
      { id: "msg_valid_1", role: "user", content: "hello" },
      { id: "item_replayed_1", role: "user", content: "again" },
    ]);

    expect(input[0]).toEqual({ id: "msg_valid_1", role: "user", content: "hello" });
    expect(input[1]).toEqual({ id: "item_replayed_1", role: "user", content: "again" });
  });

  it("preserves IDs from unknown or future item types", () => {
    const source = [
      { type: "computer_call", id: "item_computer", call_id: "call_computer", action: { type: "screenshot" } },
      { type: "apply_patch_call", id: "patch_1", call_id: "call_patch", operation: { type: "update_file" } },
      { type: "future_response_item", id: "future_1", payload: "PAYLOAD" },
    ];

    expect(transformInput(source)).toEqual(source);
  });

  it("removes bare stored references and item_reference objects only", () => {
    const storedReferences = [
      "at_stored",
      "msg_stored",
      "amsg_stored",
      "rs_stored",
      "lsh_stored",
      "fc_stored",
      "tsc_stored",
      "fco_stored",
      "ctc_stored",
      "ctco_stored",
      "tso_stored",
      "ws_stored",
      "ig_stored",
      "cmp_stored",
      "resp_stored",
    ];
    const input = transformInput([
      ...storedReferences,
      { type: "item_reference", id: "item_stored" },
      "ordinary text",
      { type: "message", id: "msg_kept", role: "user", content: "continue" },
    ]);

    expect(input).toEqual([
      "ordinary text",
      { type: "message", id: "msg_kept", role: "user", content: "continue" },
    ]);
  });

  it("normalizes function and custom call/output pairs without changing call_id", () => {
    const input = transformInput([
      { type: "function_call", id: "item_fc", call_id: "call_function", name: "shell", arguments: "{}" },
      { type: "function_call_output", id: "item_fco", call_id: "call_function", output: "done" },
      { type: "custom_tool_call", id: "item_ctc", call_id: "call_custom", name: "codex_app", input: "PAYLOAD" },
      { type: "custom_tool_call_output", id: "item_ctco", call_id: "call_custom", output: "RESULT" },
    ]);

    expect(input.map((item) => item.call_id)).toEqual([
      "call_function",
      "call_function",
      "call_custom",
      "call_custom",
    ]);
    expect(input.every((item) => !Object.hasOwn(item, "id"))).toBe(true);
  });

  it.each([58, 434])("cleans a custom tool call at input[%i] in a long replay history", (targetIndex) => {
    const history = Array.from({ length: targetIndex }, (_, index) => ({
      type: "message",
      id: `msg_history_${index}`,
      role: "user",
      content: [{ type: "input_text", text: `step ${index}` }],
    }));
    history.push({
      type: "custom_tool_call",
      id: `item_probe_${targetIndex}`,
      call_id: `call_reported_${targetIndex}`,
      name: "codex_app",
      input: "PAYLOAD",
    });
    history.push({
      type: "custom_tool_call_output",
      id: `item_probe_output_${targetIndex}`,
      call_id: `call_reported_${targetIndex}`,
      output: "RESULT",
    });

    const input = transformInput(history);

    expect(input[targetIndex - 1].id).toBe(`msg_history_${targetIndex - 1}`);
    expect(input[targetIndex]).toEqual({
      type: "custom_tool_call",
      call_id: `call_reported_${targetIndex}`,
      name: "codex_app",
      input: "PAYLOAD",
    });
    expect(input[targetIndex + 1]).toEqual({
      type: "custom_tool_call_output",
      call_id: `call_reported_${targetIndex}`,
      output: "RESULT",
    });
  });

  it("does not mutate any nested source fields during Codex transformation", () => {
    const input = [{
      type: "message",
      id: "item_system",
      role: "system",
      content: [{ type: "input_text", text: "system prompt", metadata: { keep: true } }],
    }];
    const overrides = {
      tools: [{
        type: "function",
        function: {
          name: "shell",
          description: "run command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      }],
      reasoning: { effort: "max" },
      tool_choice: { type: "function", name: "shell" },
    };
    const sourceSnapshot = structuredClone({ model: "gpt-5.6-sol", input, stream: true, ...overrides });

    const { source, transformed } = transformBody(input, overrides);

    expect(source).toEqual(sourceSnapshot);
    expect(transformed).not.toBe(source);
    expect(transformed.input[0]).toEqual({
      type: "message",
      id: "item_system",
      role: "developer",
      content: [{ type: "input_text", text: "system prompt", metadata: { keep: true } }],
    });
    expect(transformed.tools[0]).toEqual({
      type: "function",
      name: "shell",
      description: "run command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    });
    expect(transformed.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  it("logs only per-type counts and never the stripped item ID", () => {
    const probeId = "item_private_probe_58";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      transformInput([{
        type: "custom_tool_call",
        id: probeId,
        call_id: "call_private",
        name: "tool",
        input: "PAYLOAD",
      }]);

      const output = logSpy.mock.calls.flat().join(" ");
      expect(output).toContain("custom_tool_call=1");
      expect(output).not.toContain(probeId);
    } finally {
      logSpy.mockRestore();
    }
  });
});
