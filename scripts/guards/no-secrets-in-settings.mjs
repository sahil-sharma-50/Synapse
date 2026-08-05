import { read, lineOf } from "./lib.mjs";

/**
 * API keys go through the OS keychain, never `settings.json` — that file is
 * plaintext on disk and gets copied around in bug reports. A serde field named
 * anything key/secret/token-ish in settings.rs means someone reintroduced it.
 */
export const name = "no credentials in the settings.json store";

const FORBIDDEN = /\b(api_key|apikey|secret|password|access_token|refresh_token|bearer)\b/i;

export function run() {
  const src = read("synapse", "src-tauri", "src", "settings.rs");
  const errors = [];

  // Strip comments — settings.rs legitimately *discusses* API keys in prose.
  const code = src
    .replace(/\/\/.*$/gm, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  for (const m of code.matchAll(/^\s*pub\s+([a-z_0-9]+)\s*:/gm)) {
    if (FORBIDDEN.test(m[1])) {
      errors.push(
        `settings.rs:${lineOf(code, m.index)}: field \`${m[1]}\` looks like a credential. ` +
          "Secrets belong in the OS keychain (set_api_key / has_api_key), not settings.json.",
      );
    }
  }

  return errors;
}
