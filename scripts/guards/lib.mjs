import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file so guards run from any cwd. */
export const ROOT = resolve(here, "..", "..");

/**
 * `SYNAPSE_GUARD_ROOT` repoints every guard at a different tree. Only selftest
 * .mjs uses it, to run the guards against deliberately broken copies of the
 * source — a guard that cannot be made to fail is not protecting anything.
 * Read per call rather than captured at import, so the selftest can set it.
 */
export function repoPath(...parts) {
  return join(process.env.SYNAPSE_GUARD_ROOT || ROOT, ...parts);
}

export function read(...parts) {
  return readFileSync(repoPath(...parts), "utf8");
}

/**
 * Every capture group 1 of `re` across `text`. Guards are grep-shaped by
 * nature: they assert on source text rather than on parsed ASTs, because
 * pulling a TS/Rust parser in would mean the guards job has to install
 * dependencies before it can say anything.
 */
export function captureAll(text, re) {
  return [...text.matchAll(re)].map((m) => m[1]);
}

/** 1-indexed line number of `index` within `text`, for pointing at a violation. */
export function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}
