import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  PROVIDER_LABELS,
  TTS_VOICES,
  modelFor,
  type Provider,
  type Settings,
} from "./models";

const PROVIDERS: Provider[] = ["anthropic", "openai"];

function settings(overrides: Partial<Settings["ai"]> = {}): Settings {
  return {
    ai: {
      provider: "anthropic",
      anthropic_model: "claude-opus-5",
      openai_model: "gpt-4o-mini",
      ...overrides,
    },
    tts: { voice: "alba" },
    voice: { auto_stop_on_silence: false },
    clipboard: { history_enabled: true },
    onboarding_complete: true,
  };
}

describe("model catalogue", () => {
  it("covers every provider", () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_LABELS[provider]).toBeTruthy();
      expect(MODEL_CATALOG[provider].length).toBeGreaterThan(0);
    }
  });

  it("lists no duplicate models", () => {
    for (const provider of PROVIDERS) {
      const models = MODEL_CATALOG[provider];
      expect(new Set(models).size).toBe(models.length);
    }
  });
});

describe("modelFor", () => {
  it("reads the per-provider model, not the currently selected one", () => {
    // The picker keeps a model per provider so switching back and forth does
    // not lose the other provider's choice.
    const s = settings({ provider: "anthropic" });
    expect(modelFor(s, "anthropic")).toBe("claude-opus-5");
    expect(modelFor(s, "openai")).toBe("gpt-4o-mini");
  });

  it("returns a custom model that is not in the catalogue", () => {
    const s = settings({ anthropic_model: "claude-something-unreleased" });
    expect(modelFor(s, "anthropic")).toBe("claude-something-unreleased");
  });
});

describe("TTS voices", () => {
  it("are unique", () => {
    expect(new Set(TTS_VOICES).size).toBe(TTS_VOICES.length);
  });
});
