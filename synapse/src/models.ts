export type Provider = "anthropic" | "openai";

export interface AiSettings {
  provider: Provider;
  anthropic_model: string;
  openai_model: string;
}

export interface Settings {
  ai: AiSettings;
}

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
