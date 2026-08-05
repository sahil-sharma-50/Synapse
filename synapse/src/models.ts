export type Provider = "anthropic" | "openai";

export interface AiSettings {
  provider: Provider;
  anthropic_model: string;
  openai_model: string;
}

export interface TtsSettings {
  voice: string;
}

export const TTS_VOICES = ["alba", "giovanni", "lola", "juergen", "rafael", "estelle"] as const;

/** Dictation behaviour. Distinct from `TtsSettings`, which is the speaking side. */
export interface VoiceSettings {
  auto_stop_on_silence: boolean;
}

export interface ClipboardSettings {
  history_enabled: boolean;
}

export interface Settings {
  ai: AiSettings;
  tts: TtsSettings;
  voice: VoiceSettings;
  clipboard: ClipboardSettings;
  onboarding_complete: boolean;
}

// What the user actually downloaded. Both engines were previously shown as the
// bare words "Model" and "Engine", which told nobody what was on their disk or
// why it was worth ~630 MB. `sizeLabel` is the single source for the download
// size — it is also quoted in model_download.rs's doc comment, and the two used
// to disagree (650 vs 630).
export const ASR_MODEL = {
  name: "Parakeet TDT 0.6B v2",
  detail: "NVIDIA · ONNX int8 · fully offline",
  sizeLabel: "~630 MB",
} as const;

// Version is pinned in tts_setup.rs; keep the two in step.
export const TTS_ENGINE = {
  name: "pocket-tts",
  version: "2.1.0",
  detail: "Local neural voices · fully offline",
  sizeLabel: "~1–2 GB",
} as const;

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

// Curated per provider, with a "Custom…" escape hatch in the picker — model
// lineups move faster than this app ships, and a dropdown alone would make a
// newly released model unreachable until the next release.
export const MODEL_CATALOG: Record<Provider, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-4o-mini", "gpt-4o"],
};

export function modelFor(settings: Settings, provider: Provider): string {
  return provider === "anthropic"
    ? settings.ai.anthropic_model
    : settings.ai.openai_model;
}
