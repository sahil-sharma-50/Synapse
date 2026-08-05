import { read, captureAll } from "./lib.mjs";

/**
 * Window labels are the app's only routing channel (Tauri escapes `#`, so hash
 * routing silently renders the wheel everywhere). Three files have to agree:
 *
 *   lib.rs                  — the label consts, the source of truth
 *   App.tsx                 — the router that switches on them
 *   capabilities/default.json — grants IPC; a label missing here has no IPC at
 *                             all, which looks like a dead window, not an error
 *
 * The sticky-note prefix is the sharp edge: "notes-hub" does NOT match "note-",
 * but the two are one character apart, and `note-*` in the capability file
 * would happily swallow a renamed hub.
 */
export const name = "window labels agree across lib.rs, App.tsx and capabilities";

const NOTE_GLOB = "note-*";

export function run() {
  const rust = read("synapse", "src-tauri", "src", "lib.rs");
  const app = read("synapse", "src", "App.tsx");
  const caps = JSON.parse(read("synapse", "src-tauri", "capabilities", "default.json"));

  const errors = [];

  // Fixed labels declared in lib.rs, e.g. `const SETTINGS_LABEL: &str = "settings";`
  const rustLabels = captureAll(rust, /const [A-Z_]*LABEL: &str = "([^"]+)";/g);
  const rustPrefix = rust.match(/const NOTE_LABEL_PREFIX: &str = "([^"]+)";/)?.[1];

  if (!rustPrefix) {
    errors.push("lib.rs: could not find `const NOTE_LABEL_PREFIX`");
  }

  const appPrefix = app.match(/const NOTE_PREFIX = "([^"]+)";/)?.[1];
  if (!appPrefix) {
    errors.push("App.tsx: could not find `const NOTE_PREFIX`");
  }
  if (rustPrefix && appPrefix && rustPrefix !== appPrefix) {
    errors.push(
      `sticky-note label prefix differs: lib.rs "${rustPrefix}" vs App.tsx "${appPrefix}"`,
    );
  }

  // Labels the router actually handles (the `default` arm is the wheel/overlay).
  const appCases = captureAll(app, /case "([^"]+)":/g);

  const capWindows = caps.windows ?? [];
  if (!capWindows.includes(NOTE_GLOB)) {
    errors.push(
      `capabilities/default.json: missing the "${NOTE_GLOB}" glob — runtime sticky-note windows would have no IPC`,
    );
  }
  if (rustPrefix && `${rustPrefix}*` !== NOTE_GLOB) {
    errors.push(
      `capabilities/default.json: the note glob "${NOTE_GLOB}" no longer matches NOTE_LABEL_PREFIX "${rustPrefix}"`,
    );
  }

  for (const label of rustLabels) {
    if (!capWindows.includes(label)) {
      errors.push(
        `capabilities/default.json: window label "${label}" is declared in lib.rs but not granted IPC`,
      );
    }
  }

  for (const label of appCases) {
    if (!rustLabels.includes(label)) {
      errors.push(
        `App.tsx routes window label "${label}", but no matching *_LABEL const exists in lib.rs`,
      );
    }
  }

  // The near-collision that motivated this guard.
  for (const label of capWindows) {
    if (label === NOTE_GLOB) continue;
    if (rustPrefix && label.startsWith(rustPrefix)) {
      errors.push(
        `window label "${label}" starts with the sticky-note prefix "${rustPrefix}" — ` +
          "App.tsx would route it to StickyNote before reaching the switch",
      );
    }
  }

  return errors;
}
