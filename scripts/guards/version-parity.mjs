import { read } from "./lib.mjs";

/**
 * Facts the UI states about the artefacts it downloads, which are actually
 * pinned somewhere in Rust. Both pairs have drifted before: the model download
 * size read "~650MB" in one file and "~630 MB" in the other.
 */
export const name = "UI-facing versions and sizes match what Rust pins";

export function run() {
  const models = read("synapse", "src", "models.ts");
  const ttsSetup = read("synapse", "src-tauri", "src", "tts_setup.rs");
  const errors = [];

  // pocket-tts version: models.ts TTS_ENGINE.version vs the pinned pip install.
  const uiVersion = models
    .match(/export const TTS_ENGINE = \{([\s\S]*?)\} as const/)?.[1]
    ?.match(/version:\s*"([^"]+)"/)?.[1];
  const pinned = ttsSetup.match(/pocket-tts==([0-9][^"'\s]*)/)?.[1];

  if (!uiVersion) errors.push("models.ts: could not read TTS_ENGINE.version");
  if (!pinned) errors.push("tts_setup.rs: could not find the pinned `pocket-tts==<version>`");
  if (uiVersion && pinned && uiVersion !== pinned) {
    errors.push(
      `pocket-tts version drift: models.ts says "${uiVersion}", tts_setup.rs installs "${pinned}"`,
    );
  }

  // The ASR download size is quoted in model_download.rs's doc comment, which
  // explicitly asks for one number, not two.
  const uiSize = models
    .match(/export const ASR_MODEL = \{([\s\S]*?)\} as const/)?.[1]
    ?.match(/sizeLabel:\s*"~?([0-9]+)\s*MB"/)?.[1];
  const doc = read("synapse", "src-tauri", "src", "model_download.rs");
  // The doc comment deliberately recounts the old wrong number ("this used to
  // quote ~650MB"), so a line that is narrating the past is not a live claim.
  const quoted = doc
    .split("\n")
    .filter((line) => !/used to/.test(line))
    .flatMap((line) => [...line.matchAll(/~\s*([0-9]{3})\s*MB/g)].map((m) => m[1]));

  if (uiSize) {
    const wrong = quoted.filter((n) => n !== uiSize);
    if (wrong.length) {
      errors.push(
        `model_download.rs quotes a download size of ~${wrong.join("/")} MB, ` +
          `but models.ts ASR_MODEL.sizeLabel says ~${uiSize} MB — keep one number`,
      );
    }
  }

  return errors;
}
