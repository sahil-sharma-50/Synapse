import { lineOf, read } from "./lib.mjs";

export const name = "DevTools are never opened automatically";

export function run() {
  const rust = read("synapse", "src-tauri", "src", "lib.rs");

  return [...rust.matchAll(/\.open_devtools\s*\(/g)].map(
    (match) =>
      `lib.rs:${lineOf(rust, match.index)} opens DevTools automatically; open them manually when needed`,
  );
}
