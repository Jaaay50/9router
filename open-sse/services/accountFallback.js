import {
  ERROR_RULES,
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  CODEX_REQUEST_SCHEMA_ERROR_CODES,
  CODEX_REQUEST_SCHEMA_MESSAGE_PATTERN,
  CODEX_REQUEST_SCHEMA_PARAM_ROOTS,
  CODEX_ITEM_ID_PARAM_PATTERN,
  CODEX_ITEM_ID_MESSAGE_PATTERN,
  REQUEST_SCHEMA_CLASSIFICATION,
} from "../config/errorConfig.js";

function parseJsonErrorText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\[\d+\]:\s*/, "");
  const candidates = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next shape */ }
  }
  return null;
}

function hasErrorMetadata(value) {
  return Boolean(value?.type || value?.code || value?.param);
}

function isGenericBadRequestWrapper(value) {
  return String(value?.type || "").toLowerCase() === "invalid_request_error"
    && String(value?.code || "").toLowerCase() === "bad_request"
    && typeof value?.message === "string";
}

function normalizeErrorPayload(value, depth = 0) {
  if (depth > 6) return { message: "" };
  if (typeof value === "string") {
    const parsed = parseJsonErrorText(value);
    return parsed ? normalizeErrorPayload(parsed, depth + 1) : { message: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { message: String(value || "") };
  }
  if (String(value.type || "").toLowerCase() === "error"
      && value.error && typeof value.error === "object" && !Array.isArray(value.error)) {
    return normalizeErrorPayload(value.error, depth + 1);
  }
  if (hasErrorMetadata(value) && !isGenericBadRequestWrapper(value)) return value;
  if (isGenericBadRequestWrapper(value)) {
    const parsed = parseJsonErrorText(value.message);
    return parsed ? normalizeErrorPayload(parsed, depth + 1) : { message: value.message };
  }
  if (value.error && typeof value.error === "object" && !Array.isArray(value.error)) {
    return normalizeErrorPayload(value.error, depth + 1);
  }
  if (typeof value.error === "string") return normalizeErrorPayload(value.error, depth + 1);
  if (typeof value.message === "string") {
    const parsed = parseJsonErrorText(value.message);
    if (parsed) return normalizeErrorPayload(parsed, depth + 1);
  }
  return value;
}

function getSchemaParamRoot(param, message) {
  const direct = String(param || "").match(/^([a-z_]\w*)/i)?.[1];
  if (direct) return direct.toLowerCase();
  const embedded = String(message || "").match(
    /\b(?:unknown[_ ]parameter\s*:\s*|unsupported[_ ]value\s+(?:for|at)\s+)["'`]?([a-z_]\w*)/i
  )?.[1];
  return embedded?.toLowerCase() || null;
}

export function isCodexRequestSchemaError(provider, status, errorValue = "") {
  if (provider !== "codex" || Number(status) !== 400) return false;

  const error = normalizeErrorPayload(errorValue);
  const type = String(error?.type || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  const param = String(error?.param || "");
  const message = String(error?.message || (typeof error?.error === "string" ? error.error : ""));

  if (code === "invalid_prompt" || type === "invalid_prompt") return false;

  const itemIdParam = CODEX_ITEM_ID_PARAM_PATTERN.test(param)
    || /input\[\d+\]\.id/i.test(message);
  const itemIdMetadata = (!type || type === "invalid_request_error")
    && (!code || code === "invalid_value");
  if (itemIdMetadata && itemIdParam && CODEX_ITEM_ID_MESSAGE_PATTERN.test(message)) return true;

  const schemaCode = CODEX_REQUEST_SCHEMA_ERROR_CODES.has(code)
    ? code
    : (CODEX_REQUEST_SCHEMA_ERROR_CODES.has(type) ? type : null);
  const metadataAllowsMessageOnly = !code && (!type || type === "invalid_request_error");
  const schemaField = CODEX_REQUEST_SCHEMA_PARAM_ROOTS.has(getSchemaParamRoot(param, message));
  if (schemaCode === "unknown_parameter" || schemaCode === "unsupported_value") return schemaField;
  return metadataAllowsMessageOnly && schemaField && CODEX_REQUEST_SCHEMA_MESSAGE_PATTERN.test(message);
}

export function classifyProviderError(provider, status, errorText, backoffLevel = 0) {
  if (isCodexRequestSchemaError(provider, status, errorText)) {
    return { ...REQUEST_SCHEMA_CLASSIFICATION };
  }
  const { shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);
  return {
    category: "provider_error",
    accountFallback: shouldFallback,
    cooldownMs,
    comboScope: "model",
    ...(newBackoffLevel === undefined ? {} : { newBackoffLevel }),
  };
}

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
