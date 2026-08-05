import { read } from "./lib.mjs";

/**
 * `updater::REPO` decides which GitHub account's release the app downloads and
 * silently executes. A wrong value here is the worst kind of fail-silent bug:
 * it compiles, the update check succeeds, the UI reports an update, and the
 * installer that runs is someone else's. This shipped once already — the
 * constant was written against a collaborator's fork and never repointed.
 *
 * Checked against `package.json`'s `repository.url` rather than the git
 * `origin` remote on purpose: a contributor working from a fork has a
 * legitimately different origin, and a guard that cries wolf on every fork is
 * a guard people learn to ignore.
 */
export const name = "the update feed points at this project's own repository";

/** `owner/name` from a GitHub URL, in any of the forms npm accepts. */
function slug(url) {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function run() {
  const updater = read("synapse", "src-tauri", "src", "updater.rs");
  const errors = [];

  const repo = updater.match(/pub const REPO: &str = "([^"]+)"/)?.[1];
  if (!repo) {
    // Not a soft skip: if the pattern stops matching, the guard is protecting
    // nothing and should say so rather than quietly pass.
    return [
      "updater.rs: could not read `pub const REPO` — the guard no longer sees the update feed",
    ];
  }

  let declared = null;
  try {
    declared = slug(JSON.parse(read("synapse", "package.json")).repository?.url ?? "");
  } catch (e) {
    errors.push(`synapse/package.json: could not be read as JSON (${e.message})`);
  }

  if (!declared) {
    errors.push(
      "synapse/package.json: no GitHub `repository.url` for `updater::REPO` to be checked against",
    );
  } else if (declared.toLowerCase() !== repo.toLowerCase()) {
    errors.push(
      `update feed drift: updater.rs downloads and runs installers from "${repo}", ` +
        `but package.json says this project lives at "${declared}"`,
    );
  }

  // The API base is the other half of "where does the executable come from".
  const apiBase = updater.match(/pub const API_BASE: &str = "([^"]+)"/)?.[1];
  if (apiBase !== "https://api.github.com/repos") {
    errors.push(`updater.rs: API_BASE is "${apiBase}", expected GitHub's own REST API over https`);
  }

  return errors;
}
