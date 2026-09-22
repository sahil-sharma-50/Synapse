import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../models";
import { chooseAndPreviewVoice, isCurrentPreview } from "./voicePreview";

const settings: Settings = {
  ai: {
    custom_greetings: "",
    speak_replies: true,
    typing_mode: false,
    enter_to_send: true,
    provider: "openai",
    anthropic_model: "claude-sonnet-5",
    openai_model: "gpt-4o",
    openrouter_model: "openrouter/auto",
  },
  tts: { voice: "alba" },
  voice: { auto_stop_on_silence: false, silence_ms: 900, speech_threshold: 0.015 },
  clipboard: {
    history_enabled: true,
    capture_text: true,
    capture_images: true,
    capture_links: true,
    capture_files: true,
    retention_days: 30,
    max_unpinned_items: 500,
    max_storage_mb: 250,
  },
  shortcuts: { wheel: "Control+Alt+Enter", dictation: "Control+Alt+D", tools: {} },
  appearance: { wheel_size: 100, accent: "neutral", wheel_tools: ["stt", "settings"] },
  onboarding_complete: true,
};

describe("chooseAndPreviewVoice", () => {
  it("saves a changed voice before previewing it", async () => {
    const calls: string[] = [];
    await chooseAndPreviewVoice({
      voice: "lola",
      settings,
      save: (next) => calls.push(`save:${next.tts.voice}`),
      preview: async (voice) => {
        calls.push(`preview:${voice}`);
        return 7;
      },
    });
    expect(calls).toEqual(["save:lola", "preview:lola"]);
  });

  it("replays the current voice without saving again", async () => {
    const save = vi.fn();
    const preview = vi.fn(async () => 8);
    await chooseAndPreviewVoice({ voice: settings.tts.voice, settings, save, preview });
    expect(save).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledWith(settings.tts.voice);
  });
});

it("matches completion events only to the active generation", () => {
  expect(isCurrentPreview(8, 7)).toBe(false);
  expect(isCurrentPreview(8, 8)).toBe(true);
});
