import { read, captureAll } from "./lib.mjs";

/**
 * `notes::COLORS` (Rust) and `NOTE_COLORS` (TS) must list the same ids, in the
 * same order. The backend rejects any colour it does not know, so a colour
 * added on the TS side alone compiles, type-checks, renders in the picker, and
 * then silently fails to save. Order matters too: `COLORS[0]` is the default.
 */
export const name = "note colours match between Rust and TS";

export function run() {
  const rust = read("synapse", "src-tauri", "src", "notes.rs");
  const ts = read("synapse", "src", "noteColors.ts");

  const decl = rust.match(/pub const COLORS: \[&str; (\d+)\] = \[([^\]]*)\]/);
  if (!decl) {
    return ["could not find `pub const COLORS: [&str; N] = [...]` in notes.rs"];
  }
  const rustColors = captureAll(decl[2], /"([^"]+)"/g);
  const declaredLen = Number(decl[1]);

  const tsBlock = ts.match(/export const NOTE_COLORS = \[([\s\S]*?)\] as const/);
  if (!tsBlock) {
    return ["could not find `export const NOTE_COLORS = [...] as const` in noteColors.ts"];
  }
  const tsColors = captureAll(tsBlock[1], /id:\s*"([^"]+)"/g);

  const errors = [];
  if (rustColors.length !== declaredLen) {
    errors.push(
      `notes.rs: COLORS is declared as [&str; ${declaredLen}] but lists ${rustColors.length} values`,
    );
  }
  if (rustColors.join(",") !== tsColors.join(",")) {
    errors.push(
      "note colours are out of step — the backend rejects unknown colours, " +
        "so a mismatch means silent save failures.\n" +
        `  notes.rs      : [${rustColors.join(", ")}]\n` +
        `  noteColors.ts : [${tsColors.join(", ")}]`,
    );
  }
  return errors;
}
