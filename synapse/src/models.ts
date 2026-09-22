import type { WedgeId } from "./wedges";

export type Provider = "anthropic" | "openai" | "openrouter";

export interface AiSettings {
  hybrid?: boolean;
  daily_budget?: number;
  custom_greetings: string;
  provider: Provider;
  anthropic_model: string;
  openai_model: string;
  openrouter_model: string;
  speak_replies: boolean;
  typing_mode: boolean;
  enter_to_send: boolean;
}

export interface TtsSettings {
  voice: string;
}

export const TTS_VOICES = ["alba", "giovanni", "lola", "juergen", "rafael", "estelle"] as const;

/** Dictation behaviour. Distinct from `TtsSettings`, which is the speaking side. */
export interface VoiceSettings {
  auto_stop_on_silence: boolean;
  silence_ms: number;
  speech_threshold: number;
}

export interface ClipboardSettings {
  history_enabled: boolean;
  capture_text: boolean;
  capture_images: boolean;
  capture_links: boolean;
  capture_files: boolean;
  retention_days: number;
  max_unpinned_items: number;
  max_storage_mb: number;
}

export interface Settings {
  ai: AiSettings;
  tts: TtsSettings;
  voice: VoiceSettings;
  clipboard: ClipboardSettings;
  onboarding_complete: boolean;
  shortcuts: { wheel: string; dictation: string; tools: Partial<Record<WedgeId, string>> };
  appearance: {
    wheel_size: number;
    accent: "neutral" | "blue" | "violet" | "amber";
    wheel_tools: WedgeId[];
  };
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
  openrouter: "OpenRouter",
};

// Curated per provider, with a "Custom…" escape hatch in the picker — model
// lineups move faster than this app ships, and a dropdown alone would make a
// newly released model unreachable until the next release.
export const MODEL_CATALOG: Record<Provider, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-4o-mini", "gpt-4o"],
  openrouter: ["openrouter/auto"],
};

export function modelFor(settings: Settings, provider: Provider): string {
  return settings.ai[`${provider}_model`];
}
