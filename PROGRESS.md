# Synapse — Session Handoff

## CI added (2026-08-05)

PR checks now run on every pull request — see the CI section of `CLAUDE.md` for
the commands and `.github/workflows/pr.yml` for the jobs. Two things worth
knowing before you next touch this:

1. **Formatting is a ratchet.** The tree predates Prettier and rustfmt, so CI
   only checks files a PR touches. Run `npm run format` / `cargo fmt` on your
   own changes. `CLAUDE.md` documents how to retire the ratchet later.
2. **`scripts/guards/` protects fail-silent invariants** (note colours, window
   labels, keyring features, meter fill children, …). They are grep-shaped and
   so can rot silently, which is why `selftest.mjs` breaks each invariant in a
   sandbox and requires its guard to catch it. Adding a guard means adding its
   selftest case.

Clippy is now clean at `-D warnings` (six pre-existing warnings fixed), and the
frontend has ESLint + 23 Vitest tests over the pure modules.

**Still to do:** branch protection is not fully configured — required status
checks need selecting in repo settings once these checks have run once.

---

## Merge: Notepad file I/O ported onto sticky notes (2026-08-05)

PR #1 (@anirudh1804) added Save / Save As / Open to the single Notepad and
landed on `main` while the UX overhaul was still local. The overhaul deletes
Notepad entirely, so the merge had a real choice to make: drop the feature or
carry it. It was carried.

- `notes::read_from` / `write_to` and the `save_note_to` / `load_note_from`
  commands survive unchanged, as do their unit tests (73 pass now, was 71).
- `tauri-plugin-dialog` and the `dialog:default` capability stay.
- The UI moved to `StickyNote.tsx`: Open… loads a file into the note,
  Save to file… links one, Ctrl+S writes immediately.

**One deliberate semantic change.** In the Notepad, a non-null path _replaced_
the internal note as the save destination — that was the point of the bug fix
in #1, since two rival destinations meant autosave clobbered the wrong one. On
sticky notes the store is the note's identity, so `persist()` always writes the
store and _additionally_ writes the linked file. A note that stopped saving
itself because a file was linked would lose data when its window closed.

The file link is per-window and not persisted, which matches what #1 shipped
(`currentPath` was component state there too). Persisting it would need a field
on `Note` and a decision about what happens when the file moves or is deleted.

**Unverified:** no manual click-through of the ported Open / Save As dialogs.

---

## UX/UI overhaul (2026-08-02) — READ THIS FIRST, it changed a lot

Eight requested UX changes, planned at
`C:\Users\sahil\.claude\plans\use-impeccable-and-grill-me-spicy-perlis.md`.
**Automated-verified only** (`npx tsc --noEmit`, `npm run build`, `cargo build`,
`cargo test --lib` → 71 pass, zero warnings; app launches and stays up with the
ASR model loaded and no panics). **No manual click-through has been done yet** —
everything in the plan's Verification section is still outstanding.

What changed structurally:

1. **`theme.css` is new and is now the design system.** Every window stylesheet
   `@import`s it. See `DESIGN.md`.
2. **Dictation no longer auto-stops.** Enter or click the circle. Silence-stop is
   now `settings.voice.auto_stop_on_silence`, default **off**. `MAX_RECORD_MS` is
   5 min (runaway guard). New `dictation-tick` event drives a live level meter +
   timer.
3. **The wheel drags by its centre hub** (`start_overlay_drag`). Position never
   persists. The `GetAsyncKeyState` guard in that command is load-bearing — see
   its doc comment.
4. **Snippets are gone; Clipboard history replaces them.** `snippets.rs` deleted,
   `clipboard_history.rs` added; old `snippets.json` auto-migrates to pinned
   entries and the file is renamed `.migrated`, never deleted. Window label
   `snippet-picker` → `clipboard`. **Privacy: history is persisted to disk and
   will contain passwords** — the product owner chose this with the tradeoff
   stated; the off switch and Clear are the mitigation.
5. **Notepad → sticky notes, one OS window per note.** `notepad.txt`
   auto-migrates to note #1 (renamed, never deleted). Notes hub at `notes-hub`,
   notes at `note-<id>` via a capability glob.
6. **The AI panel is now a voice orb**, undecorated + transparent, with real
   multi-turn history (Rust-side `Conversation`, 20-turn cap) and
   sentence-streamed audio so speech starts before generation finishes.
7. Screenshot toast dwells 3.4s, is click-to-reveal and dismissible early.
8. Settings names the actual model/engine (`ASR_MODEL`, `TTS_ENGINE` in
   `models.ts`) and gained a Clipboard section.

**Still unverified / known risk:** pocket-tts playback has _never_ been observed
on real hardware, and this work rewrote exactly that code path
(`tts_pocket.rs` now queues clips on one long-lived sink). If audio misbehaves,
establish whether the pre-existing single-shot path worked first — otherwise an
old failure is indistinguishable from a new one.

---

**Last updated:** 2026-08-02
**Status:** M0–M4 complete and manually verified on Windows. M5 sub-project A (Settings
foundation + AI section) is built and automated-verified (build/typecheck/tests all clean);
manual click-through with a real API key is still pending — see "Known gaps" below. M5
sub-project C + M6 (onboarding wizard, resumable model download, Windows `.exe` installer packaging) is
now shipped, clearing the ship-blocker — see "Known gaps" below for what's automated-verified vs.
still a manual-only pass. M5 sub-project B (remaining settings sections) not started. **Speak
Selected Text** (pocket-tts sidecar TTS feature) is built, automated-verified, and now **merged to
`main`** — see its write-up below. Its setup pipeline has now been observed running end-to-end on
real hardware (see "Force Quit + TTS progress meter fix" below); playback itself is still
unconfirmed. Shipping as **v0.1.1**.

Read `synapse_prd.md` (rewritten this session) and the plan file at
`C:\Users\sahil\.claude\plans\so-i-am-working-ticklish-sunbeam.md` for full context/rationale.
This file is the "what to do next" summary.

---

## Environment facts (don't re-discover these)

- **Windows-only dev machine.** No Mac available — macOS-specific code (`tauri-nspanel`, vibrancy,
  Gatekeeper/TCC behavior) is written but **completely untested**. Treat any macOS claim as unverified.
- Rust toolchain, MSVC build tools, WebView2 are all installed and working.
- **Windows Smart App Control was blocking Cargo build-script binaries** — user disabled it
  (Settings → Privacy & security → Windows Security → App & browser control). If builds start
  failing with `os error 4551` / "Application Control policy has blocked this file", that's back on.
- npm install needs `npm approve-scripts esbuild` once per fresh clone (allow-scripts gate).
- `npm run tauri dev`'s own process output is unreliable to capture (buffers oddly through this
  tool). **Working pattern:** run vite dev server and the built exe as two separate `Start-Process`
  calls, redirecting the exe's stdout/stderr to a log file — this is how every bug this session got
  diagnosed. See "Dev workflow" below.

## Project layout

- App: `C:\Users\sahil\Desktop\Synapse\synapse\` (Tauri v2 + React/TS/Vite)
- PRD: `C:\Users\sahil\Desktop\Synapse\synapse_prd.md` — rewritten to match everything below;
  read it for full rationale on every architectural decision.
- Throwaway ASR proof-of-concept (not part of the app): `C:\Users\sahil\Desktop\Synapse\spikes\asr-spike\`
- Rust source: `synapse\src-tauri\src\` — `lib.rs` (orchestration + all Tauri commands/windows),
  `asr.rs`, `inject.rs`, `notes.rs`, `screenshot.rs`, `snippets.rs`, `ai.rs`, `settings.rs`
- Frontend: `synapse\src\` — `App.tsx` (router by window label), `Wheel.tsx`, `Notepad.tsx`,
  `SnippetPicker.tsx`, `AiPanel.tsx`, `Settings.tsx`, `settings/AiSection.tsx`, `models.ts`,
  `wedges.ts`

## Dev workflow (copy-paste)

```powershell
# Refresh PATH once per new terminal (rustup/cargo aren't on PATH by default in this session)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Kill any running instance
Get-Process -Name synapse -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Build
cd "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
cargo build

# Vite dev server (separate long-running process, only needs starting once)
Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" -WorkingDirectory "C:\Users\sahil\Desktop\Synapse\synapse" -WindowStyle Hidden

# Launch the built exe with logging (this is how every bug got found)
$logPath = "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri\target\debug\synapse.log"
Remove-Item $logPath, "$logPath.err" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri\target\debug\synapse.exe" `
  -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" `
  -WorkingDirectory "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
```

Then read `synapse.log` / `synapse.log.err` after reproducing a bug — `println!`/`eprintln!`
calls throughout the Rust code are the primary diagnostic tool.

Hotkeys once running: **Ctrl+Alt+Enter** opens the wheel, **Ctrl+Alt+D** starts dictation directly.

---

## What's built and verified (M0–M4)

**M0 — de-risk spike.** Overlay window + global hotkey work. `parakeet-rs` transcription proven
(1.2s model load, 0.29s to transcribe 11s of audio, CPU-only, word-perfect).

**M1 — radial wheel.** 5-wedge SVG wheel (Speech-to-Text, AI, Screenshot, Snippet, Notepad),
hover states, circular window via SVG shape (not GDI region-clip — that had hard un-antialiased
edges). Click-outside and Esc dismiss.

**M2 — Speech-to-Text.** Mic capture via `cpal`, resamples device's native config (e.g. 48kHz
stereo) to 16kHz mono — requesting 16kHz mono directly from the device fails on real hardware.
Silence detection is simple RMS energy thresholding, **not** the originally-planned ONNX VAD
(`voice_activity_detector` 0.2.0 doesn't compile against the `ort` version `parakeet-rs` pulls in
— upstream incompatibility). "Listening…" pill UI stays visible during capture. Manual stop via
click/Esc. Errors surface in the overlay instead of it silently vanishing. Clipboard paste-and-
restore injection via `enigo` + `tauri-plugin-clipboard-manager`. Direct hotkey bypasses the wheel.

**M3 — Screenshot/Snippet/Notepad.** Screenshot via `xcap` 0.9 (default-resolved 0.3 has a
different/older API — pin to 0.9) → disk (`~/Pictures/Synapse`) + clipboard, with a confirmation
toast (screenshots are otherwise invisible actions). Snippet picker and Notepad are separate
decorated windows. **Routing is by window label, not URL hash** — Tauri escapes `#` in
`WebviewUrl::App`, so hash-based routing silently failed (every window rendered the wheel) — this
cost a full debug cycle, don't repeat it. All three utility windows (Notepad/Snippet/AI) intercept
`CloseRequested` and `hide()` instead of closing — **closing a Tauri window destroys it**, so a
naive close button made windows unreusable.

**M4 — AI panel.** Text chat window, Anthropic + OpenAI both wired via raw HTTP + blocking SSE
line-reader (no official Rust SDK exists — this is the sanctioned fallback per the `claude-api`
skill). Streams via `ai-delta`/`ai-done`/`ai-error` Tauri events. API keys in OS keychain via
`keyring` crate, never in the JSON store. Inline "set API key" UI in the panel itself since
Settings (M5) doesn't exist yet. Model hardcoded to `claude-sonnet-5` / `gpt-4o-mini` — no
model picker UI exists yet.

**`keyring` needs a platform-store feature — silent-failure trap, don't undo this.** Plain
`keyring = "3"` compiles in the crate's in-memory `mock` store on Windows/macOS, and the mock
returns a _fresh empty credential_ from every `Entry::new`. Result: `set_api_key` reported
success, `has_api_key` always returned false, the panel stayed on "No key" forever, and Send
stayed disabled (`disabled={streaming || !hasKey}`) — with no error surfaced anywhere. Fixed by
declaring `keyring` with `windows-native` / `apple-native` per-target in `Cargo.toml`. Guarded by
`ai::tests::api_key_survives_a_separate_entry` (`cargo test --lib`) — the only automated test in
the repo — plus a read-back check inside `set_api_key` that errors if the key didn't persist, and
a `try/catch` in `AiPanel.saveKey` that no longer wipes the typed key on failure.

Still needs one end-to-end pass with a real key: send a message, confirm streaming + insert-into-field.

### Focus model (important architectural pivot — see PRD §6.1)

Original plan was a **non-activating** overlay (`WS_EX_NOACTIVATE`) so the wheel would never
steal focus at all. On Windows this broke mouse clicks entirely — Windows silently swallowed them,
and even a `WM_MOUSEACTIVATE` window-procedure subclass didn't fix it (evidence pointed to
Tauri/WRY's own window setup re-subclassing after ours ran). **Pivoted to capture-then-restore**:
`GetForegroundWindow()` before showing any window, `SetForegroundWindow()` back before any text
injection and on dismiss. This is standard for Windows launcher/overlay apps and is far more
robust — costs only that the underlying app's caret stops blinking while a Synapse window is open.

**This has not been validated on macOS.** `tauri-nspanel` non-activation might work fine there
(different OS, different quirk) — worth trying before assuming the Windows workaround is needed.

---

## M5 sub-project A — Settings foundation + AI section (shipped)

Design: `docs/superpowers/specs/2026-08-01-settings-foundation-ai-section-design.md`. Plan:
`docs/superpowers/plans/2026-08-01-settings-foundation-ai-section.md`.

- **`settings.rs`** — hand-rolled JSON store (`Settings { ai: AiSettings }`), mirroring
  `snippets.rs`'s pattern rather than `tauri-plugin-store` (the repo doesn't use it, despite PRD
  §6.4 implying one). `load`/`save` take a `&Path`, so they're unit-tested with no Tauri runtime:
  defaults on missing file, forward/backward-compat with unknown/missing fields (for B/C/D to add
  sections later), corrupt file falls back to defaults and is backed up to `.bak` before being
  overwritten. 3 new tests, joining the existing `ai::tests::api_key_survives_a_separate_entry`
  (4 total, `cargo test --lib`).
- **6th wheel wedge → Settings window.** New `settings` wedge (ring geometry is count-driven, no
  layout work needed). Settings window follows the established hidden-on-close pattern (Notepad/
  SnippetPicker/AiPanel) — closing it hides, never destroys.
- **`get_settings`/`update_settings`/`open_settings`/`delete_api_key` commands.** `update_settings`
  writes the file then broadcasts `settings-changed` — required because the AI panel is only ever
  hidden, never closed, so it can't be relied on to re-read config next time it's shown.
  `open_settings(section)` is the single entry point both the wheel wedge and the AI panel's
  deep-link funnel through, so they can't drift apart; it emits `settings-navigate` when a section
  is specified.
- **Settings frontend** — `Settings.tsx` (sidebar shell, currently one "AI" row — B adds more as
  they're built, no placeholder rows for unbuilt sections), `settings/AiSection.tsx` (provider
  select, per-provider model picker with a curated dropdown + "Custom…" free-text escape hatch,
  API key save/remove), `models.ts` (shared `Provider`/`Settings` types + model catalog).
- **AI panel stripped down.** `AiPanel.tsx` no longer owns provider/model/key state — it reads
  `get_settings`, listens for `settings-changed` to stay live while open, and shows a read-only
  `Provider · model` header. A missing key now shows an actionable "Open Settings…" button
  (`open_settings({ section: "ai" })`) instead of a dead-end inline key form.
- **`ai.rs` no longer hardcodes models.** `ANTHROPIC_MODEL`/`OPENAI_MODEL` consts are gone;
  `stream_chat` takes a resolved `model: &str` argument. `send_ai_message` (in `lib.rs`) loads
  settings and resolves `model_for(provider)` before calling it — `ai.rs` stays a pure HTTP/SSE
  module with no file I/O. Anthropic `max_tokens` raised 4096 → 16000: on `claude-opus-5` (now
  reachable via the model picker) extended thinking is on by default and `max_tokens` caps
  thinking _plus_ response text, so the old limit would truncate mid-answer.
- **API keys still never touch `settings.json`** — `Settings`/`AiSettings` carry no key fields;
  key management goes through the OS keychain via `set_api_key`/`delete_api_key` only.

**Consequence to carry into sub-project B:** choosing the wheel wedge over a tray icon leaves the
app with no quit path. B's General or About section must add an explicit "Quit Synapse" button.

**Verified automated:** `cargo test --lib` (4 passed), `cargo build` (clean), `npx tsc --noEmit`
(clean), and the built exe launches cleanly with the new wedge/window wired up (confirmed via the
dev-workflow log — no crash, no missing-window errors).

**Not yet verified — needs a human pass with a real API key:** the full interactive flow (open
Settings from the wheel, save a real OpenAI/Anthropic key, pick a model, confirm the AI panel
header updates live while open when Settings changes it, send a message and confirm streaming +
insert-into-field, remove a key and confirm the panel's empty state + deep-link back to Settings,
a `Custom…` model that the API rejects surfaces a real error, and that provider/model/key persist
across a relaunch). This wasn't done in this session because it requires typing a real key and
driving the desktop UI interactively — see the plan's Task 6 Step 2 for the full checklist.

## M5 sub-project C + M6 — onboarding, model download, packaging (shipped)

Design/plan: `.superpowers/sdd/2026-08-01-onboarding-msi-packaging/`.

- **`settings.rs`** — new `onboarding_complete: bool` field on `Settings` (defaults `false`),
  following the same forward/backward-compat pattern sub-project A established.
- **`model_download.rs`** — pure, Tauri-free resumable download module: issues a `Range` request
  to resume an interrupted download, writes into a `.part` file so a crash mid-download can't be
  mistaken for a complete model, rejects a truncated/short download instead of silently accepting
  it, and skips the download entirely if the model is already present. Unit-tested against
  `mockito` (resume-from-partial, truncation rejection, already-downloaded skip) — no real network
  or Tauri runtime needed for these tests.
- **Tauri wiring** — `model_status`/`download_model` commands and `model-download-progress` /
  `model-download-done` / `model-download-error` events drive the frontend progress UI.
  `asr.rs`'s previously-hardcoded relative `model/` path (a dev-only shortcut noted as a gap
  above) is now resolved through Tauri's app-data directory, so the shipped app no longer depends
  on a `model/` folder being manually copied next to the exe.
- **`check_mic_access()`** — a mic permission pre-check for onboarding's microphone step, reusing
  the existing `build_stream` helper from the M2 capture code rather than duplicating cpal setup.
- **Onboarding window/lifecycle** — a dedicated Tauri window, auto-shown on first run whenever
  `onboarding_complete` is `false`. Unlike the hide-on-close pattern used by Notepad/Snippet/AI/
  Settings, this window is **destroyed** (not hidden) when closed — it only ever needs to run
  once. Closing early (before finishing all steps) still marks onboarding complete, so a user who
  bails out isn't re-prompted every launch.
- **`Onboarding.tsx` / `.css`** — 4-step wizard: Welcome → Microphone → Model download → Done.
  Dark theme styled to match the existing `Settings.css` look.
- **`VoiceSection.tsx`** — a minimal Settings → Voice section, added as the "download later" entry
  point for anyone who skipped the model-download step during onboarding.
- **`.msi` packaging** — `tauri.conf.json`'s bundle target narrowed to `["msi"]`. A real
  `npm run tauri build` was run in this dev environment and **did succeed**, producing
  `synapse_0.1.0_x64_en-US.msi`.

**Verified automated:** `model_download.rs`'s mockito test suite (resume, truncation rejection,
already-downloaded skip), the `onboarding_complete` settings round-trip, `cargo build` and
`npx tsc --noEmit` clean, and the real `.msi` build succeeding end-to-end.

**Not yet verified — needs a human pass** (no GUI in this dev environment): double-clicking the
built installer (SmartScreen prompt, per-user install with no UAC elevation, Start Menu shortcut,
listing correctly under Windows Settings > Apps, clean uninstall), and — critically — a
fresh-profile run of onboarding end-to-end with no pre-existing `settings.json` or model files, to
confirm first-run detection and the full download-and-launch path actually work outside a dev
environment that already has a model on disk.

**Known minor/deferred items** (raised in task reviews, not blockers):

- A small idempotency race window in `spawn_download`'s `AtomicBool` guard — low impact and
  self-correcting (a duplicate spawn just resumes the same in-progress download).
- The `model_status` command has the side effect of creating the model directory even for a
  read-only status check — harmless, but worth tidying if `model_download.rs` gets touched again.
- No automated tests for `spawn_download`/`model_dir`/`DownloadProgress` — they need a real or
  mocked Tauri `AppHandle`, and the existing test harness (used for `settings.rs` and `ai.rs`,
  both `&Path`/pure-Rust testable) isn't set up for that yet.
- The `.set-section` CSS class was missing from `Settings.css` (a pre-existing gap that also
  affected the earlier AI section) — fixed as part of this work.

## Installer + first-run polish pass (2026-08-01)

Driven by a real install/first-run walkthrough on Windows 11. Four of the five reported
symptoms turned out to have distinct root causes, all now fixed and verified on-machine.

- **Installer switched from WiX `.msi` to NSIS `.exe`** (`bundle.targets: ["nsis"]`). The WiX
  dialogs (lowercase "synapse" title, red default banner, Windows-2000-era folder browser) are
  fixed by WiX itself and can only be rebranded, not modernized. NSIS is the format Tauri styles
  properly. `productName` is now `Synapse` (capital S — it drives every installer string and the
  install path), with `installer/header.bmp` (150×57) and `installer/sidebar.bmp` (164×314)
  generated from `assets/synapse_icon.png` by `src-tauri/installer/make-art.ps1` — rerun that
  script if the logo changes. `installMode: currentUser` keeps the no-UAC install behavior.
- **"12 MB / 0 MB" progress** — `spawn_download`'s HEAD size probe used reqwest's
  `Response::content_length()`, which reports the _body_ length; a HEAD reply has no body, so
  every file's size came back as 0 and the overall total was 0. Replaced with
  `remote_file_size()`, which reads the `Content-Length` / `X-Linked-Size` headers (Hugging Face
  reports the real size of LFS/Xet files only in the latter). Three mockito tests cover it.
- **The downloaded model could never load.** `MODEL_FILES` listed the repo's fp32
  `encoder-model.onnx`, which is a 42MB graph stub whose weights live in a separate 2.4GB
  `encoder-model.onnx.data` that was never downloaded — so ASR failed at startup with "External
  data path does not exist" on every install. Switched to the self-contained int8 variants
  (~630MB total, which is what the docs' "690MB" always meant). `remove_stale_files()` deletes
  the fp32 leftovers on startup and before each download, because parakeet-rs prefers the
  fp32 filename and a stale stub shadows a good download.
- **Dead "finish" button** — `core:window:allow-close` is not part of `core:default`, so
  `getCurrentWindow().close()` rejected with "window.close not allowed" and nothing happened.
  Added to `capabilities/default.json`; the promise is now awaited so any future failure shows
  in the UI instead of vanishing as an unhandled rejection. Button relabeled **Finish**.
- **Onboarding redesigned** — step rail, hero mark, feature cards, real progress meter
  (percentage, MB of MB, transfer rate, ETA, indeterminate sweep until the total is known), and
  a mic step that explains what the Windows prompt will do _before_ triggering it. Download and
  progress logic now lives in `src/modelDownload.ts` (`useModelDownload`), shared with
  Settings → Voice so both surfaces show the same meter.

**Verified on-machine:** 15 Rust tests pass; `npm run tauri build` produces
`Synapse_0.1.0_x64-setup.exe`; the installer's welcome page shows the branded sidebar and
"Welcome to Synapse Setup"; all four onboarding steps walked through in a real window; the model
downloaded end-to-end (631 MB, correct totals throughout) and logged "ASR model loaded"; Finish
closed the window and persisted `onboarding_complete`.

**Not verified:** a full install → launch → uninstall cycle from the new NSIS installer, and how
the header art reads on the fresh-install pages (only the "already installed" maintenance page
was seen).

## Speak Selected Text — pocket-tts sidecar (2026-08-02)

New wheel action: select text anywhere, trigger the wheel, choose "Speak Selected Text" and it's
read aloud via a bundled pocket-tts (Kyutai) Python sidecar, falling back to the existing
OS-native TTS when the engine isn't downloaded or the sidecar fails. Built via
`docs/superpowers/plans/2026-08-01-speak-selected-text.md`, executed task-by-task with
subagent-driven development (each task independently implemented and reviewed; a final
whole-branch review caught and fixed 5 issues before merge). Research spike notes (real
pocket-tts API + python-build-standalone release, since the plan's own draft code used
placeholders): `docs/superpowers/plans/2026-08-01-pocket-tts-api-notes.md`.

- **Architecture**: `tts_pocket.rs` owns a long-lived Python child process (spawned lazily) and
  talks newline-delimited JSON over its stdin/stdout. A single dedicated background thread owns
  all `rodio::OutputStream`/`Sink` creation, playback, and drop — `speak()` (callable from any
  thread) only ever sends `PlaybackCommand`s over an `mpsc` channel. This design replaced an
  earlier `unsafe impl Send` wrapper around `rodio::OutputStream` that a task review caught as
  unsound (real risk of cross-thread COM/WASAPI teardown issues on Windows); no `unsafe` remains
  in the final code.
- **`tts_setup.rs`** downloads an embeddable Python runtime (python-build-standalone,
  `install_only` variant), `pip install`s `torch>=2.0,<3.0` + `pocket-tts==2.1.0` (pinned exactly
  — the sidecar depends on `pocket_tts.data.audio.stream_audio_chunks`, an internal/non-public
  module verified only against 2.1.0), and pre-warms model weights with a throwaway request,
  reusing `model_download::download_one_file`/`remote_file_size` rather than reimplementing
  chunked download logic. Two corrections to the plan's own draft code, found only by actually
  downloading and inspecting the real release archive: it must be unpacked into the _parent_ of
  the python directory (the archive's paths already start with `python/...`), and pip must be
  invoked as `python.exe -m pip install` — this archive has no `Scripts/pip.exe`.
- **`resources/tts_sidecar.py`** loads the model once at import (`TTSModel.load_model()`), then
  per request calls `get_state_for_audio_prompt(voice)` → `generate_audio_stream(...)` →
  `stream_audio_chunks(out_path, chunks, sample_rate)`. Hardened to never crash the long-lived
  worker on a malformed stdin line (unguarded `json.loads` and a secondary crash inside the
  except-handler's own fallback were both found and fixed during task review).
- **Voices**: only 6 real pocket-tts built-in voices exist (`alba`, `giovanni`, `lola`, `juergen`,
  `rafael`, `estelle`, one per supported language) — the plan's draft invented a fictional
  25-name list, corrected during implementation of the Settings voice picker.
- **Final-review fixes** (all found by a whole-branch review after all 12 tasks landed, all fixed
  before merge — see `git log` for the fix commits): `speak_text` was only backgrounding its
  OS-TTS fallback path, not the pocket-tts path, so a first-run model load or a stalled sidecar
  would have frozen the whole app; added a 30s read timeout so a hung sidecar can't wedge the
  process mutex forever, and kills (rather than silently orphans) an abandoned child on any
  write/read failure; `prewarm_weights` now checks the child's real exit status/response instead
  of treating `wait()` returning `Ok` as success (previously a broken pip install could still get
  marked `READY`); all `python.exe`/`pip` spawns now set `CREATE_NO_WINDOW` on Windows; the
  cached sidecar process is now killed on `RunEvent::ExitRequested` instead of being leaked past
  app exit.
- **Automated-verified**: 31 Rust unit tests pass (settings default/persist/missing-section,
  selected-text-capture decision logic, sidecar protocol encode/decode + staleness detection,
  setup marker-file readiness), `cargo build` and `npx tsc --noEmit` both clean.
- **Not verified** (needs a live display + audio device + real network bandwidth, none available
  in the environment this was built in): the actual `download_tts_engine` pipeline end-to-end
  (Python runtime download, pip install, weight prewarm), sidecar process spawn/respawn on a real
  machine, audio playback, the wheel wedge's visual layout, Settings → Voice and the onboarding
  step's UI. One already-known cosmetic gap: the voice `<select>` in Settings uses
  `className="set-select"` but no matching rule exists yet in `Settings.css`, so it'll render
  unstyled until that's added.

## Force Quit wedge + TTS progress meter fix (2026-08-02, v0.1.1)

**Force Quit wedge.** The wheel now has an eighth wedge, `quit`, appended last in `wedges.ts` so it
lands next to Settings — deliberately the furthest point from where the wheel opens under the
cursor, since the action is irreversible. Clicking it invokes the new `force_quit` Tauri command,
which calls `app.exit(0)`, the same path the tray's "Quit Synapse" item already used. **No
confirmation step, by explicit product decision** — the whole point is a fast way to reclaim
background resources; restart is via the app icon. `WedgeDef` gained an optional `danger` flag that
drives a `.wedge-danger` class, filling the slice red on hover instead of the usual blue. This
partially covers the "Quit Synapse button" item listed under M5 sub-project B below.

**TTS setup looked hung — root-caused as a rendering bug, not a hang.** Onboarding's voice-engine
step sat on "Installing packages…" with a dead, empty bar. Setup was in fact completing normally
(~2min 17s to the `READY` marker, ~1 GB installed). Three defects compounded:

1. Both indeterminate meters were rendered as _childless_ self-closing divs
   (`<div className="ob-meter ob-meter-idle" />`), but the sweep animation is defined on a
   **descendant** selector (`.ob-meter-idle .ob-meter-fill`). With no child there was nothing to
   animate — a permanently frozen track. `settings/VoiceSection.tsx` had the identical bug with
   `.set-meter-idle`. The ASR meter in the same files nests the child correctly, which is why only
   the TTS bars looked broken.
2. `useTtsSetup()` discarded `bytes_downloaded`/`bytes_total` entirely, keeping only `stage` — even
   though the `python` stage emits real byte counts with a correct total.
3. `run_pip_install` uses `cmd.status()`, which blocks and discards pip's stdout, so the longest
   stage (`packages`, torch CPU) emits a single `0/0` event and then goes silent for ~90s.

Fixed 1 and 2: the hook now exposes `downloaded`/`total`/`known`/`percent`, both consumers nest the
`-fill` div, and the `python` stage shows a real percentage plus "X of Y". Stages that genuinely
have nothing countable (`packages`, `weights`) now show an _animated_ sweep rather than a frozen
bar. **Fix 3 was deliberately not attempted** — parsing pip's stdout depends on an output format
pip does not guarantee as an API.

**Verified:** `npx tsc --noEmit` clean, `cargo build` clean, `npm run tauri build` produced the NSIS
installer, and the dev build launched and ran the TTS setup pipeline to completion on real hardware.
**Not verified:** nobody has yet watched the _fixed_ meters animate through all three stages, and
actual TTS audio playback still hasn't been observed.

**Bundle targets stay NSIS-only.** Re-adding the WiX `.msi` was considered and rejected again for
the same reason as before — its dialogs can only be rebranded, not modernized.

## Known gaps / not yet done

- **M5 sub-project A manual verification** — see above.
- **M5 sub-project B — remaining settings sections.** General (dynamic hotkeys, launch at login,
  **Quit Synapse button** — see consequence above), Microphone, Capture, Snippets CRUD, Voice/ASR,
  Permissions, About. Not started.
- **M5 sub-project C + M6 — onboarding, model download, packaging.** Shipped — see the write-up
  below. Automated-verified: `model_download.rs`'s resumable-download logic (mockito-tested:
  resume, truncation rejection, already-downloaded skip), `settings.rs`'s `onboarding_complete`
  field, `cargo build`/`npx tsc --noEmit` clean, and a real `npm run tauri build` that did produce
  the NSIS installer (`Synapse_0.1.1_x64-setup.exe`; the bundle target moved from WiX `.msi` to
  NSIS — see the installer polish write-up). **Still manual-only** (no GUI in this dev environment): the
  installer double-click itself (SmartScreen prompt, per-user install with no UAC, Start Menu
  shortcut, Windows Settings > Apps listing, uninstall) and a fresh-profile onboarding
  end-to-end run with no pre-existing `settings.json`/model files. macOS `.dmg` packaging and
  ad-hoc signing are still untouched (blocked on having a Mac to test, per the macOS gap below).
- macOS is entirely unverified — every macOS-specific code path (`#[cfg(target_os = "macos")]`,
  vibrancy, `tauri-nspanel`) needs testing on real hardware.
- No frontend automated tests exist (by design for sub-project A — see the design doc's "Out of
  scope"). Rust unit tests now live in `settings.rs`, `ai.rs`, `model_download.rs`, `inject.rs`,
  `tts_setup.rs`, `tts_pocket.rs`, and `lib.rs`. Everything else is manual click-through — notably
  every meter/progress UI, which is exactly where the v0.1.1 frozen-bar bug hid.
- **Speak Selected Text — manual end-to-end pass still incomplete.** The setup pipeline (Python
  download, pip install, weight prewarm) _has_ now been observed completing on real hardware, and
  the wheel/onboarding UI has been seen. **Still unobserved: sidecar spawn for a real request and
  actual audio playback**, plus the fixed progress meters animating through all three stages.
  `.set-select` CSS rule is missing for the voice dropdown (cosmetic).
  `python_path()` isn't dogfooded by `prewarm_weights` (minor DRY nit), and the downloaded
  python-build-standalone tarball is left on disk inside the wipeable `tts-env/` directory after
  extraction (disk space only). macOS is untested for this feature same as everything else.

## Next steps, in order

1. Manual click-through of M5 sub-project A with a real API key (see above) — confirms the
   settings foundation before building on top of it.
2. Human verification pass for M5 sub-project C + M6 (see the write-up below): install the built
   NSIS `.exe` on a clean/fresh profile, walk through onboarding end-to-end with no pre-existing
   settings/model files, and confirm the standard installer behaviors (SmartScreen, per-user
   install, Start Menu shortcut, Apps listing, uninstall).
3. M5 sub-project B: the remaining settings sections, including the Quit button.
4. **Speak Selected Text — finish the manual end-to-end pass** (see write-up above). Setup now
   completes on real hardware; what remains is: confirm the _fixed_ progress meters animate through
   all three stages (delete `%APPDATA%\com.synapse.app\tts-env\READY` to force a re-run), pick a
   voice, select text in another app and speak it, verify interrupting mid-speech works, verify the
   AI panel's read-aloud also picks up the pocket-tts voice, and verify the OS-native fallback
   still works when the engine isn't downloaded.
5. macOS packaging (`.dmg`, ad-hoc signing) — blocked on having a Mac to test.
6. Whenever a Mac becomes available: validate the entire macOS code path before assuming any of
   it works — vibrancy, focus behavior, Gatekeeper/TCC flow, permissions.
