import { readFileSync, readdirSync } from "node:fs";
import { repoPath, read, lineOf } from "./lib.mjs";

/**
 * `theme.css` is the design system: colour, spacing, type, radius, elevation and
 * motion are all tokens there, and window stylesheets are supposed to consume
 * them rather than retype values. Before it existed the same background was
 * typed in four files and error red existed in three shades.
 *
 * The codebase is not at zero yet, so this is a *ratchet*, not a wall: each file
 * carries a baseline count in `css-baseline.json` and the check fails only when
 * a file goes above its baseline. Fixing violations is expected to lower the
 * baseline — run `node scripts/guards/css-tokens.mjs --update` to re-record it.
 */
export const name = "no new raw hex colours or bare px spacing in window stylesheets";

// Resolved lazily, not at import, so SYNAPSE_GUARD_ROOT can repoint them.
const cssDir = () => repoPath("synapse", "src");
const baselineFile = () => repoPath("scripts", "guards", "css-baseline.json");

// theme.css is where raw values are supposed to live.
const EXEMPT = new Set(["theme.css"]);

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
// Spacing declarations written as literal px instead of a spacing token.
const BARE_PX = /(?:^|[;{]\s*)(gap|row-gap|column-gap|padding|margin)\s*:\s*[^;{}]*?\d+px/gm;

function stylesheets() {
  return readdirSync(cssDir())
    .filter((f) => f.endsWith(".css") && !EXEMPT.has(f))
    .sort();
}

function countFile(file) {
  const src = readFileSync(repoPath("synapse", "src", file), "utf8");
  // Strip comments so a hex quoted in prose does not count.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const hex = [...code.matchAll(HEX)].map((m) => ({
    kind: "hex",
    line: lineOf(code, m.index),
    text: m[0],
  }));
  const px = [...code.matchAll(BARE_PX)].map((m) => ({
    kind: "px",
    line: lineOf(code, m.index),
    text: m[0].trim(),
  }));
  return { hex, px };
}

export function measure() {
  const out = {};
  for (const file of stylesheets()) {
    const { hex, px } = countFile(file);
    out[file] = { hex: hex.length, px: px.length };
  }
  return out;
}

export function run() {
  const baseline = JSON.parse(read("scripts", "guards", "css-baseline.json"));
  const errors = [];

  for (const file of stylesheets()) {
    const { hex, px } = countFile(file);
    const base = baseline[file] ?? { hex: 0, px: 0 };

    for (const [kind, found] of [
      ["hex", hex],
      ["px", px],
    ]) {
      const allowed = base[kind] ?? 0;
      if (found.length > allowed) {
        const what = kind === "hex" ? "raw hex colour(s)" : "bare px spacing declaration(s)";
        const sample = found
          .slice(-3)
          .map((v) => `      ${file}:${v.line}  ${v.text}`)
          .join("\n");
        errors.push(
          `${file}: ${found.length} ${what}, baseline allows ${allowed}. ` +
            `Use a token from theme.css.\n${sample}`,
        );
      }
    }
  }

  // Keep the ratchet honest: if a file drops below its baseline, ask for the
  // baseline to be lowered so the win cannot be silently spent later.
  for (const file of stylesheets()) {
    const { hex, px } = countFile(file);
    const base = baseline[file];
    if (!base) continue;
    if (hex.length < base.hex || px.length < base.px) {
      errors.push(
        `${file}: improved past its baseline (hex ${base.hex}→${hex.length}, px ${base.px}→${px.length}). ` +
          "Run `node scripts/guards/css-tokens.mjs --update` to lock the win in.",
      );
    }
  }

  return errors;
}

// `node scripts/guards/css-tokens.mjs --update` re-records the baseline.
if (process.argv.includes("--update")) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(baselineFile(), `${JSON.stringify(measure(), null, 2)}\n`);
  console.log(`updated ${baselineFile()}`);
}
