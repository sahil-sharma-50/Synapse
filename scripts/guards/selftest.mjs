#!/usr/bin/env node
/**
 * Proves each guard can actually fail. A grep-shaped guard rots quietly: rename
 * a const, reflow a JSX block, and the pattern stops matching anything — the
 * guard still reports "ok" and protects nothing. So for every guard we copy the
 * tree, break the exact invariant it owns, and require it to complain.
 *
 *   node scripts/guards/selftest.mjs
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const SOURCES = [
  "synapse/src",
  "synapse/src-tauri/src",
  "synapse/src-tauri/capabilities",
  "scripts/guards",
];

/**
 * Each case: which guard module, and a mutation applied to the copied tree.
 * `edit(file, fn)` rewrites one file in the sandbox.
 */
const CASES = [
  {
    guard: "./note-colors.mjs",
    what: "a colour added to TS but not Rust",
    break: (edit) =>
      edit("synapse/src/noteColors.ts", (s) =>
        s.replace(
          '{ id: "slate", label: "Slate" },',
          '{ id: "slate", label: "Slate" },\n  { id: "violet", label: "Violet" },',
        ),
      ),
  },
  {
    guard: "./note-colors.mjs",
    what: "colours reordered so COLORS[0] changes the default",
    break: (edit) =>
      edit("synapse/src/noteColors.ts", (s) =>
        s
          .replace('{ id: "amber", label: "Amber" },\n', "")
          .replace(
            '{ id: "slate", label: "Slate" },',
            '{ id: "slate", label: "Slate" },\n  { id: "amber", label: "Amber" },',
          ),
      ),
  },
  {
    guard: "./window-labels.mjs",
    what: "a window label dropped from the capability file",
    break: (edit) =>
      edit("synapse/src-tauri/capabilities/default.json", (s) => s.replace('"clipboard", ', "")),
  },
  {
    guard: "./window-labels.mjs",
    what: "the notes hub renamed into the sticky-note prefix",
    break: (edit) =>
      edit("synapse/src-tauri/capabilities/default.json", (s) =>
        s.replace('"notes-hub"', '"note-hub"'),
      ),
  },
  {
    guard: "./meter-fill.mjs",
    what: "an indeterminate meter rendered as a childless track",
    break: (edit) =>
      edit("synapse/src/settings/VoiceSection.tsx", (s) =>
        s.replace(
          /<div className=\{`set-meter \$\{model\.known \? "" : "set-meter-idle"\}`\}>[\s\S]*?<\/div>/,
          '<div className={`set-meter ${model.known ? "" : "set-meter-idle"}`} />',
        ),
      ),
  },
  {
    guard: "./css-tokens.mjs",
    what: "a raw hex colour added to a window stylesheet",
    break: (edit) =>
      edit("synapse/src/Settings.css", (s) => `${s}\n.regression { color: #ff00aa; }\n`),
  },
  {
    guard: "./keyring-features.mjs",
    what: "keyring's windows-native feature dropped",
    break: (edit) =>
      edit("synapse/src-tauri/Cargo.toml", (s) =>
        s.replace('keyring = { version = "3", features = ["windows-native"] }', 'keyring = "3"'),
      ),
  },
  {
    guard: "./no-secrets-in-settings.mjs",
    what: "an api_key field added to the settings store",
    break: (edit) =>
      edit("synapse/src-tauri/src/settings.rs", (s) =>
        s.replace("pub struct AiSettings {", "pub struct AiSettings {\n    pub api_key: String,"),
      ),
  },
  {
    guard: "./version-parity.mjs",
    what: "the UI's pocket-tts version drifting from the pinned pip install",
    break: (edit) =>
      edit("synapse/src/models.ts", (s) => s.replace('version: "2.1.0"', 'version: "2.2.0"')),
  },
  {
    guard: "./update-feed.mjs",
    what: "the update feed repointed at someone else's repository",
    break: (edit) =>
      edit("synapse/src-tauri/tauri.conf.json", (s) =>
        s.replace("github.com/sahil-sharma-50/Synapse", "github.com/someone-else/Synapse"),
      ),
  },
  {
    guard: "./update-feed.mjs",
    what: "the updater's signing pubkey emptied out",
    break: (edit) =>
      edit("synapse/src-tauri/tauri.conf.json", (s) =>
        s.replace(/"pubkey": "[^"]*"/, '"pubkey": ""'),
      ),
  },
  {
    guard: "./update-feed.mjs",
    what: "updater artifacts (and with them the .sig files) turned off",
    break: (edit) =>
      edit("synapse/src-tauri/tauri.conf.json", (s) =>
        s.replace('"createUpdaterArtifacts": true', '"createUpdaterArtifacts": false'),
      ),
  },
];

let failures = 0;

for (const [i, testCase] of CASES.entries()) {
  const sandbox = mkdtempSync(join(tmpdir(), "synapse-guards-"));
  try {
    for (const dir of SOURCES) {
      cpSync(join(ROOT, dir), join(sandbox, dir), { recursive: true });
    }
    cpSync(
      join(ROOT, "synapse/src-tauri/Cargo.toml"),
      join(sandbox, "synapse/src-tauri/Cargo.toml"),
    );
    cpSync(join(ROOT, "synapse/package.json"), join(sandbox, "synapse/package.json"));
    cpSync(
      join(ROOT, "synapse/src-tauri/tauri.conf.json"),
      join(sandbox, "synapse/src-tauri/tauri.conf.json"),
    );

    const edit = (rel, fn) => {
      const path = join(sandbox, rel);
      const before = readFileSync(path, "utf8");
      const after = fn(before);
      if (after === before) {
        throw new Error(
          `mutation for "${testCase.what}" changed nothing — the selftest itself is stale`,
        );
      }
      writeFileSync(path, after);
    };
    testCase.break(edit);

    process.env.SYNAPSE_GUARD_ROOT = sandbox;
    // Cache-bust: the same module is imported once per case, but its state is
    // all read at run() time, so a plain import is enough.
    const guard = await import(testCase.guard);
    const errors = guard.run();
    delete process.env.SYNAPSE_GUARD_ROOT;

    if (errors.length === 0) {
      failures += 1;
      console.log(`  FAIL  [${i + 1}] ${guard.name}\n        did not catch: ${testCase.what}`);
    } else {
      console.log(`  ok    [${i + 1}] catches ${testCase.what}`);
    }
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  [${i + 1}] ${testCase.what}\n        ${e.message}`);
  } finally {
    delete process.env.SYNAPSE_GUARD_ROOT;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log("");
if (failures > 0) {
  console.log(`${failures} of ${CASES.length} guard selftests failed.`);
  process.exit(1);
}
console.log(`All ${CASES.length} guard selftests passed.`);
