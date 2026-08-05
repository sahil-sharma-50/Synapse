import { read } from "./lib.mjs";

/**
 * The nastiest failure mode in this repo: with no platform-store feature,
 * `keyring` compiles in its in-memory `mock` store. Everything builds, every
 * test passes, `set_api_key` returns Ok — and the key is gone the moment the
 * process exits. There is no compile error to catch it, so it gets a guard.
 */
export const name = "keyring declares a native platform store per target";

const REQUIRED = [
  [/\[target\.'cfg\(windows\)'\.dependencies\]/, "windows-native", "cfg(windows)"],
  [
    /\[target\.'cfg\(target_os = "macos"\)'\.dependencies\]/,
    "apple-native",
    'cfg(target_os = "macos")',
  ],
];

export function run() {
  const toml = read("synapse", "src-tauri", "Cargo.toml");
  const errors = [];

  for (const [sectionRe, feature, label] of REQUIRED) {
    const start = toml.search(sectionRe);
    if (start === -1) {
      errors.push(`Cargo.toml: missing [target.${label}.dependencies] section`);
      continue;
    }
    // Section runs until the next [table] header.
    const rest = toml.slice(start + 1);
    const end = rest.search(/^\[/m);
    const section = end === -1 ? rest : rest.slice(0, end);

    const line = section.match(/^keyring\s*=\s*(.+)$/m)?.[1];
    if (!line) {
      errors.push(
        `Cargo.toml [${label}]: no keyring entry — without a platform store feature ` +
          "keyring silently compiles its in-memory mock and API keys never persist",
      );
      continue;
    }
    if (!line.includes(feature)) {
      errors.push(
        `Cargo.toml [${label}]: keyring is missing the "${feature}" feature (found: ${line.trim()}). ` +
          'Plain `keyring = "3"` compiles the mock store, which reports success and stores nothing.',
      );
    }
  }

  return errors;
}
