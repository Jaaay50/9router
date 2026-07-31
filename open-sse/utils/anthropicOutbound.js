import { FORMATS } from "../translator/formats.js";
import {
  ANTHROPIC_BETA_FEATURES,
  ANTHROPIC_BETA_HEADER,
  CLAUDE_CODE_BETA,
  CLAUDE_SESSION_HEADER,
  CONTEXT_MANAGEMENT_BETA,
  MAX_CLAUDE_SESSION_ID_LENGTH,
  VALID_ANTHROPIC_BETA,
} from "../config/anthropicBeta.js";

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function getHeaderValues(headers, name) {
  if (!headers) return [];
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? [] : [value];
  }
  return Object.keys(headers)
    .filter(candidate => candidate.toLowerCase() === name.toLowerCase())
    .map(key => headers[key]);
}

function deleteHeader(headers, name) {
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

function setCanonicalHeader(headers, name, value) {
  deleteHeader(headers, name);
  if (value) headers[name.toLowerCase()] = value;
}

function parseBetaFlags(value, validate = false) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  return raw
    .split(",")
    .map(flag => flag.trim())
    .filter(Boolean)
    .filter(flag => !validate || VALID_ANTHROPIC_BETA.test(flag));
}

function getRequestSessionId(headers) {
  const value = getHeader(headers, CLAUDE_SESSION_HEADER);
  if (typeof value !== "string") return null;
  if (value.length > MAX_CLAUDE_SESSION_ID_LENGTH || /[\r\n]/.test(value)) return null;
  const sessionId = value.trim();
  return sessionId || null;
}

function isOfficialAnthropicUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function allowsAnthropicBetaFeature(policy, flag) {
  return Array.isArray(policy) && policy.includes(flag);
}

export function finalizeAnthropicOutboundRequest({
  url,
  headers,
  transformedBody,
  credentials,
  provider,
  targetFormat,
  featurePolicy,
}) {
  if (targetFormat !== FORMATS.CLAUDE) return { url, headers, transformedBody };

  const finalizedHeaders = { ...headers };
  const officialAnthropic = isOfficialAnthropicUrl(url);
  let finalizedBody = transformedBody;

  // Session identity is request-scoped and only valid for the official endpoint.
  deleteHeader(finalizedHeaders, CLAUDE_SESSION_HEADER);
  const requestSessionId = getRequestSessionId(credentials?.rawHeaders);
  if (officialAnthropic && requestSessionId) {
    finalizedHeaders[CLAUDE_SESSION_HEADER] = requestSessionId;
  }

  const contextManagementPresent = ANTHROPIC_BETA_FEATURES[0].present(transformedBody);
  const contextManagementAllowed = officialAnthropic
    || allowsAnthropicBetaFeature(featurePolicy, CONTEXT_MANAGEMENT_BETA);
  if (contextManagementPresent && !contextManagementAllowed) {
    finalizedBody = { ...transformedBody };
    delete finalizedBody.context_management;
  }

  const betaFlags = new Set(parseBetaFlags(getHeaderValues(finalizedHeaders, ANTHROPIC_BETA_HEADER)));
  if (!officialAnthropic) {
    // Dynamic Anthropic-compatible gateways may accept only Bearer auth.
    if (provider?.startsWith?.("anthropic-compatible-")
        && credentials?.apiKey
        && !getHeader(finalizedHeaders, "authorization")) {
      finalizedHeaders.Authorization = `Bearer ${credentials.apiKey}`;
    }
    betaFlags.delete(CLAUDE_CODE_BETA);
    if (!contextManagementAllowed) betaFlags.delete(CONTEXT_MANAGEMENT_BETA);
    deleteHeader(finalizedHeaders, "anthropic-dangerous-direct-browser-access");
    deleteHeader(finalizedHeaders, "x-app");
  }

  const requestBetaFlags = parseBetaFlags(
    getHeaderValues(credentials?.rawHeaders, ANTHROPIC_BETA_HEADER),
    true
  );
  for (const flag of requestBetaFlags) {
    if (officialAnthropic || allowsAnthropicBetaFeature(featurePolicy, flag)) betaFlags.add(flag);
  }

  for (const feature of ANTHROPIC_BETA_FEATURES) {
    if (!feature.present(finalizedBody)) continue;
    if (officialAnthropic || allowsAnthropicBetaFeature(featurePolicy, feature.flag)) {
      betaFlags.add(feature.flag);
    }
  }

  setCanonicalHeader(finalizedHeaders, ANTHROPIC_BETA_HEADER, Array.from(betaFlags).join(","));
  return { url, headers: finalizedHeaders, transformedBody: finalizedBody };
}
