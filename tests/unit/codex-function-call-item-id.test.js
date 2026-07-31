import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function transformInput(input) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.6-sol",
    input,
    stream: true,
  };

  executor.transformRequest("gpt-5.6-sol", body, true, {
    connectionId: "test-codex-stateless-item-id",
    providerSpecificData: {},
  });

  return body.input;
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

    const input = transformInput(source);

    expect(input).toHaveLength(source.length);
    input.forEach((item, index) => {
      expect(item).toEqual({ type, ...fixture.payload, sequence: index });
    });
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

  it("leaves non-target hosted, shell, patch, and compaction items unchanged", () => {
    const source = [
      { type: "computer_call", id: "cmp_1", call_id: "call_computer", action: { type: "screenshot" } },
      { type: "local_shell_call", id: "shell_1", call_id: "call_shell", action: { command: ["pwd"] } },
      { type: "apply_patch_call", id: "patch_1", call_id: "call_patch", operation: { type: "update_file" } },
      { type: "compaction", id: "comp_1", encrypted_content: "COMPACTED" },
    ];

    expect(transformInput(source)).toEqual(source);
  });

  it("removes bare stored references and item_reference objects only", () => {
    const input = transformInput([
      "rs_stored",
      "fc_stored",
      "ctc_stored",
      "resp_stored",
      "msg_stored",
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

  it("cleans a custom tool call at input[434] in a long replay history", () => {
    const history = Array.from({ length: 434 }, (_, index) => ({
      type: "message",
      id: `msg_history_${index}`,
      role: "user",
      content: [{ type: "input_text", text: `step ${index}` }],
    }));
    history.push({
      type: "custom_tool_call",
      id: "item_probe_434",
      call_id: "call_reported_434",
      name: "codex_app",
      input: "PAYLOAD",
    });
    history.push({
      type: "custom_tool_call_output",
      id: "item_probe_output_434",
      call_id: "call_reported_434",
      output: "RESULT",
    });

    const input = transformInput(history);

    expect(input[433].id).toBe("msg_history_433");
    expect(input[434]).toEqual({
      type: "custom_tool_call",
      call_id: "call_reported_434",
      name: "codex_app",
      input: "PAYLOAD",
    });
    expect(input[435]).toEqual({
      type: "custom_tool_call_output",
      call_id: "call_reported_434",
      output: "RESULT",
    });
  });
});
