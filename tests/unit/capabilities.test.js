import { describe, expect, it } from "vitest";
import {
  getCapabilitiesForModel,
  PROVIDER_CAPABILITIES,
} from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
  const claudeAdaptive1mExpected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  const kiroGpt56Expected = {
    contextWindow: 272000,
    maxOutput: 128000,
    thinkingFormat: "openai",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("resolves Claude 4.6+ families and aliases to shared 1M adaptive capabilities", () => {
    for (const model of [
      "claude-opus-4.6",
      "claude-opus-4-6-thinking",
      "anthropic/claude-opus-4.7-fast",
      "us.anthropic.claude-opus-4-8-agentic",
      "vendor/anthropic/claude-opus-4.8-20260731-thinking",
      "vendor/claude-opus-4-8-preview-20260731",
      "claude-opus-5",
      "claude-opus-5-thinking-agentic",
      "claude-sonnet-4.6",
      "claude-sonnet-4.6-1m",
      "claude-sonnet-4-6-thinking",
      "claude-sonnet-4.6-thinking-1m",
      "anthropic/claude-sonnet-4.7-fast-agentic",
      "vendor/claude-sonnet-5-2026-07-31",
      "vendor/claude-opus-5-1m",
      "claude-fable-5",
      "anthropic/claude-fable-5-fast",
    ]) {
      expect(getCapabilitiesForModel("github", model)).toMatchObject(claudeAdaptive1mExpected);
    }
  });

  it("keeps provider-specific overrides ahead of the Claude family resolver", () => {
    const provider = "capability-test-provider";
    PROVIDER_CAPABILITIES[provider] = {
      "claude-opus-4-8-fast": { thinkingFormat: "openai", contextWindow: 300000, maxOutput: 32000 },
    };

    try {
      expect(getCapabilitiesForModel(provider, "vendor/claude-opus-4-8-fast")).toMatchObject({
        thinkingFormat: "openai",
        contextWindow: 300000,
        maxOutput: 32000,
      });
    } finally {
      delete PROVIDER_CAPABILITIES[provider];
    }
  });

  it("reports Kiro GPT 5.6 models with the Kiro 272k context window", () => {
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "openai/gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-terra-thinking")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-luna-agentic")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol-thinking-agentic")).toMatchObject(kiroGpt56Expected);
  });
});
