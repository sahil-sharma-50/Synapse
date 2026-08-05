#!/usr/bin/env node
/**
 * Repo-specific invariants that neither the compiler nor the type checker can
 * see. Every guard here exists because the invariant it protects has a
 * fail-silent mode: the code builds, runs, and does the wrong thing.
 *
 *   node scripts/guards/run.mjs
 *
 * Deliberately dependency-free so CI can run it without an npm install.
 */
import * as noteColors from "./note-colors.mjs";
import * as windowLabels from "./window-labels.mjs";
import * as meterFill from "./meter-fill.mjs";
import * as cssTokens from "./css-tokens.mjs";
import * as keyringFeatures from "./keyring-features.mjs";
import * as noSecrets from "./no-secrets-in-settings.mjs";
import * as versionParity from "./version-parity.mjs";
import * as updateFeed from "./update-feed.mjs";

const GUARDS = [
  noteColors,
  windowLabels,
  meterFill,
  cssTokens,
  keyringFeatures,
  noSecrets,
  versionParity,
  updateFeed,
];

let failed = 0;

for (const guard of GUARDS) {
  let errors;
  try {
    errors = guard.run();
  } catch (e) {
    errors = [`guard threw: ${e.message}`];
  }

  if (errors.length === 0) {
    console.log(`  ok    ${guard.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${guard.name}`);
    for (const e of errors) {
      console.log(`        ${e.split("\n").join("\n        ")}`);
    }
  }
}

console.log("");
if (failed > 0) {
  console.log(`${failed} guard(s) failed.`);
  process.exit(1);
}
console.log(`All ${GUARDS.length} guards passed.`);
