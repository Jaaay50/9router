import { describe, it, expect } from "vitest";

import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  describe("OpenAI GPT-5.5/5.6 token limits", () => {
    it.each([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])("renames max_tokens for %s", (model) => {
      const body = { max_tokens: 400 };

      stripUnsupportedParams("openai", model, body);

      expect(body).toEqual({ max_completion_tokens: 400 });
    });

    it("supports thinking suffixes", () => {
      const body = { max_tokens: 400 };

      stripUnsupportedParams("openai", "gpt-5.6-sol(max)", body);

      expect(body).toEqual({ max_completion_tokens: 400 });
    });

    it("keeps the native field when both token limit fields are present", () => {
      const body = { max_tokens: 400, max_completion_tokens: 800 };

      stripUnsupportedParams("openai", "gpt-5.6-sol", body);

      expect(body).toEqual({ max_completion_tokens: 800 });
    });

    it("keeps an existing native field unchanged", () => {
      const body = { max_completion_tokens: 800 };

      stripUnsupportedParams("openai", "gpt-5.6-sol", body);

      expect(body).toEqual({ max_completion_tokens: 800 });
    });

    it("does not add a token limit when neither field is present", () => {
      const body = { temperature: 0.2 };

      stripUnsupportedParams("openai", "gpt-5.6-sol", body);

      expect(body).toEqual({ temperature: 0.2 });
    });

    it("only renames the top-level field", () => {
      const body = {
        max_tokens: 400,
        metadata: { max_tokens: 200 },
      };

      stripUnsupportedParams("openai", "gpt-5.6-sol", body);

      expect(body).toEqual({
        max_completion_tokens: 400,
        metadata: { max_tokens: 200 },
      });
    });

    it.each([
      ["openai", "gpt-5.4"],
      ["openai", "gpt-5.6-sol-preview"],
      ["github", "gpt-5.6-sol"],
      ["openai-compatible-chat-test", "gpt-5.6-sol"],
    ])("leaves non-target %s/%s requests unchanged", (provider, model) => {
      const body = { max_tokens: 400 };

      stripUnsupportedParams(provider, model, body);

      expect(body).toEqual({ max_tokens: 400 });
    });

    it("is idempotent", () => {
      const body = { max_tokens: 400 };

      stripUnsupportedParams("openai", "gpt-5.6-sol", body);
      stripUnsupportedParams("openai", "gpt-5.6-sol", body);

      expect(body).toEqual({ max_completion_tokens: 400 });
    });

    it("runs through DefaultExecutor before dispatch", () => {
      const executor = new DefaultExecutor("openai");

      const transformed = executor.transformRequest("gpt-5.6-sol", {
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 400,
      });

      expect(transformed).toEqual({
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 400,
      });
    });

    it("normalizes a Responses token limit after translating to Chat Completions", () => {
      const executor = new DefaultExecutor("openai");
      const chatBody = openaiResponsesToOpenAIRequest("gpt-5.6-sol", {
        input: "hello",
        max_output_tokens: 400,
      });

      const transformed = executor.transformRequest("gpt-5.6-sol", chatBody);

      expect(transformed.max_completion_tokens).toBe(400);
      expect(transformed).not.toHaveProperty("max_tokens");
      expect(transformed).not.toHaveProperty("max_output_tokens");
    });
  });
});
