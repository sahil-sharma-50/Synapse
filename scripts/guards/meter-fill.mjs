import { read, lineOf } from "./lib.mjs";

/**
 * Both indeterminate progress meters animate through a *descendant* selector
 * (`.ob-meter-idle .ob-meter-fill`, `.set-meter-idle .set-meter-fill`), so a
 * childless track renders as a permanently empty bar that users read as a hang.
 * This has shipped as a bug once already.
 *
 * The check is textual: a `<div className={...-meter...}>` must not be
 * self-closing, and must contain a `-fill` element before its close tag.
 */
export const name = "indeterminate progress meters nest a -fill child";

const FILES = [
  ["synapse", "src", "Onboarding.tsx"],
  ["synapse", "src", "settings", "VoiceSection.tsx"],
];

// Opening tag of a meter *track*. The `(?!-)` lookahead is load-bearing: the
// file is full of `ob-meter-head`, `ob-meter-foot`, `ob-meter-idle` and
// `ob-meter-fill`, and only the bare `ob-meter` / `set-meter` class is a track.
const METER_TAG = /<div\s+className=\{?[^>]*?\b(ob-meter|set-meter)\b(?!-)[^>]*?>/g;
const SELF_CLOSING = /<div\s+className=\{?[^>]*?\b(?:ob|set)-meter\b(?!-)[^>]*?\/>/g;

export function run() {
  const errors = [];

  for (const parts of FILES) {
    const src = read(...parts);
    const file = parts.slice(1).join("/");

    for (const m of src.matchAll(SELF_CLOSING)) {
      errors.push(
        `${file}:${lineOf(src, m.index)}: self-closing meter track — the sweep animation ` +
          "lives on a descendant `-fill` selector, so this renders as a frozen empty bar",
      );
    }

    for (const m of src.matchAll(METER_TAG)) {
      if (m[0].includes("-fill")) continue;
      // Look ahead a bounded window for the fill child; meters are small.
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 600);
      const closes = after.indexOf("</div>");
      const body = closes === -1 ? after : after.slice(0, closes + 6);
      if (!body.includes(`${m[1]}-fill`)) {
        errors.push(
          `${file}:${lineOf(src, m.index)}: \`.${m[1]}\` track has no \`.${m[1]}-fill\` child — ` +
            "an indeterminate meter still needs the fill div to animate",
        );
      }
    }
  }

  return errors;
}
