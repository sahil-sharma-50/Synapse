import { read } from "./lib.mjs";

/**
 * The updater config decides which releases this app installs and which key
 * must have signed them. Both halves fail silently if wrong.
 *
 * The endpoint shipped pointing at a contributor's fork once already — it was
 * written against the repo they could publish test releases to, and nothing
 * caught it: the check succeeds, the UI reports an update, and the installer
 * that runs is someone else's.
 *
 * The pubkey is worse, because it fails *open* in the direction that matters:
 * a placeholder left in place ships a build whose only integrity check is one
 * that cannot pass, and the failure shows up as "updates are broken" long
 * after release rather than at build time.
 *
 * Checked against `package.json`'s `repository.url` rather than the git
 * `origin` remote on purpose: a contributor working from a fork has a
 * legitimately different origin, and a guard that cries wolf on every fork is
 * a guard people learn to ignore.
 */
export const name = "the updater installs signed releases from this project's own repository";

/** `owner/name` from a GitHub URL, in any of the forms npm accepts. */
function slug(url) {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function run() {
  const errors = [];

  let config;
  try {
    config = JSON.parse(read("synapse", "src-tauri", "tauri.conf.json"));
  } catch (e) {
    return [`tauri.conf.json: could not be read as JSON (${e.message})`];
  }

  const updater = config.plugins?.updater;
  if (!updater) {
    return ["tauri.conf.json: no `plugins.updater` — the guard no longer sees the update feed"];
  }

  // A missing or placeholder key disables the only thing standing between a
  // user and an attacker-supplied installer.
  const pubkey = updater.pubkey;
  if (!pubkey || /REPLACE|TODO|CHANGEME|^$/i.test(pubkey)) {
    errors.push(
      "tauri.conf.json: `plugins.updater.pubkey` is unset or still a placeholder — " +
        "generate one with `npm run tauri signer generate` and keep the private half in CI secrets",
    );
  }

  if (config.bundle?.createUpdaterArtifacts !== true) {
    errors.push(
      "tauri.conf.json: `bundle.createUpdaterArtifacts` must be true, or releases ship " +
        "without the .sig files the updater requires",
    );
  }

  const endpoints = updater.endpoints ?? [];
  if (endpoints.length === 0) {
    errors.push("tauri.conf.json: `plugins.updater.endpoints` is empty");
  }

  let declared = null;
  try {
    declared = slug(JSON.parse(read("synapse", "package.json")).repository?.url ?? "");
  } catch (e) {
    errors.push(`synapse/package.json: could not be read as JSON (${e.message})`);
  }

  if (!declared) {
    errors.push(
      "synapse/package.json: no GitHub `repository.url` for the update endpoint to be checked against",
    );
  }

  for (const endpoint of endpoints) {
    if (!endpoint.startsWith("https://")) {
      errors.push(`update endpoint is not https: ${endpoint}`);
      continue;
    }
    if (!declared) continue;
    const target = slug(endpoint.replace(/\/releases\/.*$/, ""));
    if (!target || target.toLowerCase() !== declared.toLowerCase()) {
      errors.push(
        `update feed drift: the updater installs releases from "${endpoint}", ` +
          `but package.json says this project lives at "${declared}"`,
      );
    }
  }

  return errors;
}
