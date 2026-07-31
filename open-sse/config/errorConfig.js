// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

export const CODEX_REQUEST_SCHEMA_ERROR_CODES = new Set([
  "unknown_parameter",
  "unsupported_value",
]);

export const CODEX_REQUEST_SCHEMA_MESSAGE_PATTERN = /\b(?:unknown[_ ]parameter|unsupported[_ ]value)\b/i;
export const CODEX_REQUEST_SCHEMA_PARAM_ROOTS = new Set([
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "store",
  "reasoning",
  "service_tier",
  "include",
  "prompt_cache_key",
  "client_metadata",
  "text",
]);
export const CODEX_ITEM_ID_PARAM_PATTERN = /^input\[\d+\]\.id$/;
export const CODEX_ITEM_ID_MESSAGE_PATTERN = /expected an id that begins with ["'`]\w+["'`]/i;

export const CLAUDE_SCHEMA_FIELD_MESSAGE_PATTERN = /(?:^|[\s"'`])(?:[a-z_]\w*(?:\.\w+|\[\d+\])*)["'`]?\s*:\s*extra inputs are not permitted\b/i;
export const CLAUDE_BETA_HEADER_MESSAGE_PATTERN = /(?:\banthropic[-_ ]beta\b(?:\s+header)?\s*(?::|contains?|has|includes?)\s*(?:an?\s+)?(?:invalid|unsupported|unknown|unrecognized)\s+(?:beta\s+)?(?:value|flag|token|feature|version|name)\b|\b(?:invalid|unsupported|unknown|unrecognized)\s+(?:(?:value|flag|token|feature|version|name)\s+(?:for|in)\s+)?(?:the\s+)?anthropic[-_ ]beta(?:\s+header)?(?:\s+(?:value|flag|token|feature|version|name))?\b)/i;
export const CLAUDE_INVALID_PROMPT_MESSAGE_PATTERN = /\binvalid[_ ]prompt\b/i;
export const CLAUDE_PERMISSION_MESSAGE_PATTERN = /(?:\b(?:unauthorized|unauthorised|forbidden|permission|entitlement)\b|\b(?:account|org(?:anization|anisation)?|workspace|subscription|plan|model)\b.{0,80}\b(?:access|permission|entitlement|unsupported|does\s+not\s+have|not\s+(?:allowed|available|enabled|entitled|supported))\b|\b(?:access|permission|entitlement|unsupported|does\s+not\s+have|not\s+(?:allowed|available|enabled|entitled|supported))\b.{0,80}\b(?:account|org(?:anization|anisation)?|workspace|subscription|plan|model)\b)/i;

export const REQUEST_SCHEMA_CLASSIFICATION = Object.freeze({
  category: "request_schema",
  accountFallback: false,
  cooldownMs: 0,
  comboScope: "provider",
});

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
