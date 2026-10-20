/**
 * Tests for the Pi CLI-tools card (`POST /api/cli-tools/pi-settings`).
 *
 * The route is the only writer of `~/.pi/agent/models.json` from the dashboard,
 * so a failure here is a dead Apply button — not a cosmetic bug. It used to
 * throw `ReferenceError: existingProvider is not defined` on every save, which
 * also meant the whole provider block was rebuilt from scratch whenever it did
 * work.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome;
let dbKeys;
let postPiSettings;

function request(body) {
  return new Request("https://9router.local/api/cli-tools/pi-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function modelsJsonPath() {
  return path.join(tempHome, ".pi", "agent", "models.json");
}

function readModelsJson() {
  return JSON.parse(fs.readFileSync(modelsJsonPath(), "utf-8"));
}

function writeModelsJson(value) {
  fs.mkdirSync(path.dirname(modelsJsonPath()), { recursive: true });
  fs.writeFileSync(modelsJsonPath(), JSON.stringify(value, null, 2), "utf-8");
}

describe("Pi CLI-tools settings route", () => {
  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pi-settings-"));
    dbKeys = [{ key: "sk-active", isActive: true }];
    vi.resetModules();

    vi.doMock("node:os", async () => {
      const actual = await vi.importActual("node:os");
      const homedir = () => tempHome;
      return { ...actual, default: { ...actual, homedir }, homedir };
    });
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    vi.doMock("@/lib/db", () => ({ getApiKeys: async () => dbKeys }));

    ({ POST: postPiSettings } = await import("@/app/api/cli-tools/pi-settings/route.js"));
  });

  afterEach(() => {
    vi.doUnmock("node:os");
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/db");
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates the provider block when the config has none", async () => {
    const response = await postPiSettings(
      request({ baseUrl: "http://127.0.0.1:20128", model: "cc/claude-opus" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });

    const block = readModelsJson().providers["9router"];
    expect(block).toMatchObject({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-active",
      api: "openai-completions",
    });
    expect(block.models[0]).toMatchObject({ id: "cc/claude-opus", name: "cc/claude-opus" });
  });

  it("keeps the existing api mode and the other providers on save", async () => {
    writeModelsJson({
      providers: {
        "9router": { baseUrl: "http://127.0.0.1:20128/v1", apiKey: "sk-stored", api: "anthropic" },
        other: { baseUrl: "https://example.test/v1", apiKey: "sk-other" },
      },
    });

    const response = await postPiSettings(
      request({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk-new", model: "cc/claude-opus" }),
    );
    expect(response.status).toBe(200);

    const config = readModelsJson();
    expect(config.providers["9router"]).toMatchObject({ apiKey: "sk-new", api: "anthropic" });
    // Untouched providers survive the save.
    expect(config.providers.other).toMatchObject({ apiKey: "sk-other" });
  });

  it("never writes the sk_9router placeholder the card sends", async () => {
    dbKeys = [];
    writeModelsJson({
      providers: { "9router": { baseUrl: "http://127.0.0.1:20128/v1", apiKey: "sk-stored" } },
    });

    await postPiSettings(
      request({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk_9router", model: "cc/claude-opus" }),
    );

    expect(readModelsJson().providers["9router"].apiKey).toBe("sk-stored");
  });

  it("resolves the active dashboard key when the card has no key selected", async () => {
    writeModelsJson({
      providers: { "9router": { baseUrl: "http://127.0.0.1:20128/v1", apiKey: "sk-stale" } },
    });

    await postPiSettings(
      request({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk_9router", model: "cc/claude-opus" }),
    );

    expect(readModelsJson().providers["9router"].apiKey).toBe("sk-active");
  });

  it("carries an explicit model list through with its own limits", async () => {
    await postPiSettings(
      request({
        baseUrl: "http://127.0.0.1:20128",
        models: [
          "cc/claude-opus",
          { id: "cx/gpt-6", name: "GPT-6", contextWindow: 524288, maxTokens: 65536 },
        ],
      }),
    );

    const models = readModelsJson().providers["9router"].models;
    expect(models).toHaveLength(2);
    expect(models[1]).toMatchObject({ id: "cx/gpt-6", contextWindow: 524288, maxTokens: 65536 });
  });

  it("rejects a body without a base URL instead of writing", async () => {
    const response = await postPiSettings(request({ model: "cc/claude-opus" }));
    expect(response.status).toBe(400);
    expect(fs.existsSync(modelsJsonPath())).toBe(false);
  });
});
