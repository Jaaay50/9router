export const ANTHROPIC_BETA_HEADER = "anthropic-beta";
export const CLAUDE_SESSION_HEADER = "x-claude-code-session-id";
export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
export const CLAUDE_CODE_BETA = "claude-code-20250219";
export const VALID_ANTHROPIC_BETA = /^[a-z0-9][a-z0-9-]{0,127}$/i;
export const MAX_CLAUDE_SESSION_ID_LENGTH = 256;

// Keep body-field-to-beta coupling in one table so future features need one mapping.
export const ANTHROPIC_BETA_FEATURES = Object.freeze([
  {
    flag: CONTEXT_MANAGEMENT_BETA,
    present: body => Object.prototype.hasOwnProperty.call(body || {}, "context_management"),
  },
  {
    flag: "effort-2025-11-24",
    present: body => Object.prototype.hasOwnProperty.call(body?.output_config || {}, "effort"),
  },
  {
    flag: "advanced-tool-use-2025-11-20",
    present: body => Array.isArray(body?.tools)
      && body.tools.some(tool => Object.prototype.hasOwnProperty.call(tool || {}, "input_examples")),
  },
  {
    flag: "structured-outputs-2025-12-15",
    present: body => Object.prototype.hasOwnProperty.call(body?.output_config || {}, "format"),
  },
]);
