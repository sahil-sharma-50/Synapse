import type { Settings } from "../models";

interface ChooseVoiceInput {
  voice: string;
  settings: Settings;
  save: (settings: Settings) => void;
  preview: (voice: string) => Promise<number>;
}

export async function chooseAndPreviewVoice({ voice, settings, save, preview }: ChooseVoiceInput) {
  if (voice !== settings.tts.voice) {
    save({ ...settings, tts: { ...settings.tts, voice } });
  }
  return preview(voice);
}

export const isCurrentPreview = (active: number | null, completed: number) => active === completed;
