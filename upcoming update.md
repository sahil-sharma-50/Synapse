# Upcoming update

Working notes for the next release. Written after the first real end-to-end
in-app update (v0.2.0 -> v0.2.1) on 2026-08-06.

## Where the updater actually stands

The update path is **shipped and working**. v0.2.0 and v0.2.1 are both signed
and published, and an update between them ran on real hardware.

Verified, with evidence rather than assumption:

| Behaviour               | Result   | How it was established                                                                                                                                                                                                                 |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing chain           | pass     | Key id in `plugins.updater.pubkey` matches the id in both shipped signatures (`d66a7cd7436241c7`); Ed25519 signature verifies against BLAKE2b-512 of the installer bytes, checked offline for v0.2.0 and v0.2.1 independently of Tauri |
| Endpoint resolution     | pass     | Installed v0.2.0 reached `releases/latest/download/latest.json`, parsed it, and reported "Update available: v0.2.1"                                                                                                                    |
| Version comparison      | pass     | Same as above — 0.2.0 correctly read as older than 0.2.1                                                                                                                                                                               |
| In-process verification | pass     | The plugin accepted the artifact and installed it; v0.2.1 is now running                                                                                                                                                               |
| Onboarding suppression  | pass     | The onboarding window is built hidden and shown only when `show_onboarding` is true. Had `.update-pending` failed, a setup wizard would have appeared on screen. Nothing appeared.                                                     |
| Relaunch after install  | **open** | See below                                                                                                                                                                                                                              |

## The open item: the update is invisible

**Symptom.** The app closed during install and appeared not to come back. The
user launched it manually and found v0.2.1.

**Most likely cause — not a failure of the restart.** `tauri-plugin-updater`
defaults `restart_after_install` to `true`, so it passes `/R` to the NSIS
installer, and the installer honours `/R` in passive mode
(`.onInstSuccess` -> `nsis_tauri_utils::RunAsUser`). Synapse almost certainly
_did_ relaunch — into the tray, with every window hidden, which looks exactly
like not starting.

This is the same trap already documented in `installer/hooks.nsh` for fresh
installs: "every Synapse window starts hidden, so ... the finish page's 'Run
Synapse' checkbox launches an app with no visible window at all and reads as
doing nothing." Updates hit it too.

**Discriminating question, still unanswered:** when the app was launched again
after the update, did the radial wheel appear at the cursor? If yes, the app
was already running and `tauri-plugin-single-instance` summoned the wheel on
the existing process — the restart worked. If no wheel appeared, it was a cold
start and the relaunch genuinely failed.

## Planned fix: make a successful update visible

Regardless of which branch the answer falls on, an update currently gives the
user **no evidence it succeeded**, while the UI promises "Synapse will
restart". That is the real defect.

`run()` already reads the `.update-pending` marker into `after_update` to
suppress onboarding, so the same signal can drive a confirmation. On the first
launch after an update, show the Settings window on the Updates section with an
"Updated to v0.2.1" confirmation, instead of returning silently to the tray.

- If the restart is working (likely), this converts an invisible relaunch into
  a visible one and is the whole fix.
- If the restart is not working, this still belongs, and the relaunch needs
  separate investigation — start by confirming `/R` reaches the installer and
  that `RunAsUser` is not being blocked.

Do not add a "please restart Synapse" message as a substitute. The app is a
tray app; the honest fix is to prove it came back, not to ask the user to do it.

## Smaller items queued behind that

- **Badge capitalisation.** Settings -> Updates renders the current version as
  `V0.2.0` (uppercase) beside `v0.2.1` (lowercase). The markup uses a lowercase
  `v`; `.set-badge` uppercases it. Pick one and make both agree.
- **`installMode`.** Currently `"passive"`, which shows an NSIS progress dialog
  on top of the in-app progress bar — two progress UIs for one operation. That
  was the right call while the path was unproven (a stall is visible), but now
  that an update has been observed, `"quiet"` is a one-line change worth
  considering.
- **Version-parity guard.** `package.json`, `package-lock.json`,
  `tauri.conf.json`, `Cargo.toml` and `Cargo.lock` must all carry the same
  version or `release.yml` produces a release the updater misreads. That
  invariant is currently documented in CLAUDE.md but not enforced. It is a
  textbook `scripts/guards/` case: fail-silent, grep-shaped, cheap to check.
- **PR #20 description.** Still has every checklist box ticked with What / Why /
  Verified how unfilled. Merged ahead of it deliberately; worth asking the
  contributor to fill in retroactively so the record is accurate.

## Release procedure, for reference

1. Bump the version in `package.json` (use `npm version <x> --no-git-tag-version`,
   which updates `package-lock.json` too), `tauri.conf.json` and `Cargo.toml`,
   then run `cargo check` to refresh `Cargo.lock`. All five must agree.
2. Open a PR — `main` is protected. A maintainer-authored release bump cannot be
   self-approved, so it needs either another reviewer or `gh pr merge --admin`
   (note the bypass in the merge body when using it).
3. Tag `v<version>` and push the tag. `release.yml` builds, signs with
   `TAURI_SIGNING_PRIVATE_KEY`, generates `latest.json` and publishes a
   non-draft release.
4. Confirm the release is not a draft. The endpoint resolves through
   `releases/latest/download/latest.json` and will 404 otherwise.

**The signing key is the maintainer's and only the maintainer's.** Whoever holds
the private half can sign an installer that every install accepts and executes
without prompting. It is not generated on, transmitted to, or shared with any
machine outside the project. See the PROGRESS.md entry for the full custody note.
