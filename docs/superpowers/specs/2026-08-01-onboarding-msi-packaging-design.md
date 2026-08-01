# Onboarding wizard + first-run model download + Windows .msi packaging (design)

**Scope:** M5 sub-project C (onboarding + model download) and M6 (Windows packaging), combined
into one spec since together they're what "anyone can install and run Synapse on Windows"
actually requires. macOS packaging/onboarding is explicitly out of scope — no Mac is available to
test on (see PROGRESS.md).

**Ship-blocker context:** the app currently cannot be installed by anyone but the dev machine —
the ASR model is loaded from a hardcoded relative `model/` directory that only exists because it
was copied in manually during development (see `asr.rs`'s `preload_model()`). This spec removes
that blocker.

---

## 1. Onboarding wizard

### 1.1 Window & trigger

A new dedicated Tauri window, label `onboarding`, decorated (title bar, closable) — unlike the
circular wheel and the hide-on-close utility windows (Notepad/Snippet/AI/Settings), this window
is one-time and gets destroyed normally on close, not hidden.

Trigger: `Settings` gains a new field, `onboarding_complete: bool` (defaults `false` for new
installs, matching the existing forward/backward-compat pattern in `settings.rs`). At startup,
`lib.rs` checks this flag: if `false`, open the `onboarding` window instead of going straight to
normal idle-in-tray-equivalent state (there is no tray icon — see PROGRESS.md's "no quit path"
note; the app is just running, wheel hotkey armed, until the user invokes it). Once onboarding
finishes (or is closed by the user at any step), `onboarding_complete` is set `true` and the
window closes for good — there is no "redo onboarding" entry point in v1.

If the wizard is closed early (X button) at any step, treat it the same as reaching the final
step: mark `onboarding_complete = true`. Anything not done (mic not granted, model not downloaded)
is recoverable later via the mic-denied deep link and the new Settings → Voice section
respectively — see below.

### 1.2 Steps

1. **Welcome** — app name, one-line pitch, "Get Started".
2. **Microphone** — explains why (dictation). "Grant Access" opens a `cpal` device stream and
   immediately closes it, which is what surfaces the Windows mic-permission prompt if not already
   granted. Three states: not-yet-requested / granted (green check) / denied (red, with a link
   that opens `ms-settings:privacy-microphone` via the OS shell). "Continue" is always enabled —
   this step is informational, not a hard gate.
3. **Model download** — explains size (~690MB) and purpose (offline dictation). "Download Now"
   starts the streaming download with a progress bar (MB downloaded / MB total, transfer speed).
   "Skip for now" advances immediately. Errors during download show inline with a "Retry" button
   that resumes from the partial file. Success auto-advances to the next step.
4. **Done** — confirms setup, "Open Synapse" closes the window.

Navigation is forward-only plus a "Back" link — no free-jump stepper, since this is a linear
one-time flow, not a settings page users return to.

### 1.3 Visual style

Reuses the existing dark theme / blue-accent visual language from `Settings.css`
(`#1a1a1c` background, `#eaeaea` text, `#5aaaff`-family accent, existing `.set-btn`/`.set-badge`
conventions) rather than introducing a new palette. New CSS lives in `Onboarding.css`, following
the same naming convention (`.ob-*` prefix) as the existing per-window stylesheets.

---

## 2. Model download

### 2.1 Storage location

`app_data_dir()/model/` (resolved via Tauri's path API), replacing the hardcoded relative
`"model"` string in `asr.rs::preload_model()`. `preload_model()` now takes the resolved path as
an argument (passed from `lib.rs`'s setup hook, which has access to the `AppHandle`) and only
attempts `ParakeetTDT::from_pretrained(...)` if all 4 required files
(`config.json`, `decoder_joint-model.onnx`, `encoder-model.onnx`, `vocab.txt`) are present — a
missing/partial model is not an error at startup, just means dictation is unavailable until
downloaded.

### 2.2 Download mechanism

New `model_download.rs` module:

- Source: the same 4 files from `https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx`
  already documented in README.md — no separate hosting/CDN needed.
- Each file streams via `reqwest` to `<file>.part` in the model directory, renamed to its final
  name only after a successful, size-verified write.
- **Resumable:** if a `.part` file exists on (re)start of a download, issue the request with a
  `Range: bytes=<existing-len>-` header and append. If the server doesn't honor the range (no
  `206` response), fall back to restarting that file from scratch.
- **Integrity check:** compare final file size against the `Content-Length` reported by the
  server for that request. Mismatch after a supposedly-complete download → treat as failure,
  discard the `.part`/final file, surface an error, let the user retry. (No cryptographic
  checksum for v1 — HuggingFace doesn't expose one without an extra API round-trip, and
  size-verification is enough to catch truncation, the realistic failure mode here.)
- Progress reported via Tauri events, mirroring the existing `ai-delta`/`ai-done`/`ai-error`
  pattern used for AI streaming: `model-download-progress` (`{ file, bytesDownloaded, bytesTotal }`
  per file plus an overall aggregate), `model-download-done`, `model-download-error` (message).
- New commands: `download_model()` (starts/resumes; idempotent — calling it again while a
  download is in progress is a no-op, not a second concurrent download) and `model_status()`
  (returns whether all 4 files are present and valid, for both the onboarding step and the
  Settings → Voice section to query on mount).

### 2.3 Settings → Voice section (new, minimal)

`settings/VoiceSection.tsx`, added as a new row in `Settings.tsx`'s `SECTIONS` array. Scope is
deliberately narrow — model status (not-downloaded / downloading with progress / ready) and a
Download/Re-download button, reusing `download_model()`/`model_status()`. This is the "download
later" entry point for anyone who skipped it in onboarding. Sub-project B (remaining settings
sections) later extends this same file with mic-device selection etc. — nothing here is
throwaway.

---

## 3. Windows .msi packaging

`tauri.conf.json`'s `bundle.targets` changes from `"all"` to an explicit list including `"msi"`
(Tauri's WiX-based bundler — no custom WiX authoring needed). Defaults: per-user install (no
admin/UAC prompt), Start Menu shortcut, standard entry in Windows' "Apps" uninstall list.
Unsigned, per PRD §8's already-accepted tradeoff — SmartScreen will show its standard
"unrecognized app" warning; this is expected, not a bug to work around.

`"all"` currently also produces an NSIS `.exe` and other bundle types; narrowing to an explicit
list avoids unexpectedly shipping/testing installer formats nobody asked for. Exact final list
decided during implementation (at minimum `["msi"]`).

---

## 4. Error handling summary

- Mic permission denied → non-blocking; recoverable via the deep link in step 2 or by Windows
  settings directly at any later time (Windows re-checks the permission live, no app restart
  needed).
- Download network failure mid-stream → `.part` kept, error event carries a message, UI offers
  Retry (resumes, doesn't restart).
- Download completes with a size mismatch → treated as failure, partial/final file discarded,
  user can retry from scratch.
- App relaunched mid-onboarding (crash/force-quit) → `onboarding_complete` still `false`, wizard
  reopens at Welcome (no persisted mid-wizard step — this is a one-time flow, not worth state
  persistence complexity). Any `.part` file left on disk is still resumed automatically once the
  user reaches the download step again.

---

## 5. Testing

- **Rust unit tests** (`model_download.rs`): range-request resume offset calculation, `.part` →
  final rename on success, size-mismatch rejection — against a local mock HTTP server (no real
  network dependency in CI).
- **Rust unit test** (`settings.rs`): roundtrip test for the new `onboarding_complete` field,
  extending the existing default/forward/backward-compat test pattern from sub-project A.
- **Frontend:** no automated tests, matching this project's existing precedent (manual
  click-through only, documented as a deliberate scope choice in sub-project A's design). This
  area needs a real manual pass since it's the actual ship-blocker: install via the built `.msi`
  on a machine/profile without the dev `model/` folder already present, run onboarding, download
  the model, confirm dictation works end-to-end.
- **Packaging:** build the `.msi`, install on a clean path, confirm Start Menu entry and
  uninstall via Windows "Apps" settings, confirm the expected SmartScreen warning appears.

---

## 6. Out of scope (this spec)

- macOS onboarding/permissions/packaging — no Mac available to test on; deferred per
  PROGRESS.md's "next steps" ordering.
- GitHub-releases update-checker (PRD §8) — needs a real release to check against, which doesn't
  exist yet; revisit after v1 ships once.
- Full Permissions settings page (screen recording / UI-automation concepts from the PRD) —
  Windows doesn't gate text-injection behind an OS permission the way macOS does, so there's
  nothing to build there for Windows-only v1.
- Sub-project B's remaining settings sections (General/Microphone/Capture/Snippets/Permissions/
  About, including the Quit button) — unrelated to this ship-blocker, stays next in the existing
  order.
