import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

const STORED_ITEM_REFERENCE_PATTERN = /^(?:at|msg|amsg|rs|lsh|fc|tsc|fco|ctc|ctco|tso|ws|ig|cmp|resp)_/;
const UNTRUSTED_STATELESS_ID_TYPES = new Set([
  RESPONSES_ITEM.FUNCTION_CALL,
  RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
  RESPONSES_ITEM.CUSTOM_TOOL_CALL,
  RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT,
]);
const RESPONSE_ITEM_ID_PREFIXES = new Map([
  [RESPONSES_ITEM.ADDITIONAL_TOOLS, "at"],
  [RESPONSES_ITEM.MESSAGE, "msg"],
  [RESPONSES_ITEM.AGENT_MESSAGE, "amsg"],
  [RESPONSES_ITEM.REASONING, "rs"],
  [RESPONSES_ITEM.LOCAL_SHELL_CALL, "lsh"],
  [RESPONSES_ITEM.FUNCTION_CALL, "fc"],
  [RESPONSES_ITEM.TOOL_SEARCH_CALL, "tsc"],
  [RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, "fco"],
  [RESPONSES_ITEM.CUSTOM_TOOL_CALL, "ctc"],
  [RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT, "ctco"],
  [RESPONSES_ITEM.TOOL_SEARCH_OUTPUT, "tso"],
  [RESPONSES_ITEM.WEB_SEARCH_CALL, "ws"],
  [RESPONSES_ITEM.IMAGE_GENERATION_CALL, "ig"],
  [RESPONSES_ITEM.COMPACTION, "cmp"],
  [RESPONSES_ITEM.CONTEXT_COMPACTION, "cmp"],
]);

function getResponseItemType(item) {
  return item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);
}

/**
 * Remove stored references and untrusted item IDs from a stateless Responses replay.
 * Tool call/output IDs are always omitted because call_id is the correlation key.
 * Other known IDs are retained only when their type-specific prefix is valid.
 * Unknown types retain plausible typed IDs but drop generic item_* replay IDs.
 */
export function normalizeStatelessResponseInput(input, { stripUnknownIds = false } = {}) {
  const strippedIds = {};
  if (!Array.isArray(input)) return { input, strippedIds };

  const normalizedInput = input.flatMap((item) => {
    if (typeof item === "string" && STORED_ITEM_REFERENCE_PATTERN.test(item)) return [];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
    if (item.type === RESPONSES_ITEM.ITEM_REFERENCE) return [];
    if (!Object.hasOwn(item, "id")) return [item];

    const type = getResponseItemType(item);
    const expectedPrefix = RESPONSE_ITEM_ID_PREFIXES.get(type);
    const hasExpectedId = typeof item.id === "string"
      && expectedPrefix
      && item.id.startsWith(`${expectedPrefix}_`)
      && item.id.length > expectedPrefix.length + 1;
    const hasPlausibleUnknownId = typeof item.id === "string"
      && item.id.length > 0
      && !item.id.startsWith("item_");
    const shouldStrip = UNTRUSTED_STATELESS_ID_TYPES.has(type)
      || (expectedPrefix ? !hasExpectedId : (stripUnknownIds && !hasPlausibleUnknownId));

    if (!shouldStrip) return [item];
    const normalizedItem = { ...item };
    delete normalizedItem.id;
    const countKey = type || "unknown";
    strippedIds[countKey] = (strippedIds[countKey] || 0) + 1;
    return [normalizedItem];
  });

  return { input: normalizedInput, strippedIds };
}

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      result.messages.push({ role: item.role, content });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
      }
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Add tool result
      pendingToolResults.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Skip reasoning items - they are for display only
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}
