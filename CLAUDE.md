# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Synapse is a cross-platform (Windows-first, macOS untested) desktop utility built with Tauri v2 (Rust backend) + React/TypeScript (frontend). A global hotkey (`Ctrl+Alt+Enter`) opens a circular radial menu at the cursor with actions: Speech-to-Text, AI chat, Screenshot, Snippet, Notepad, Speak Selected Text, Settings, Force Quit.

Read `synapse_prd.md` for full product rationale and `PROGRESS.md` for session-by-session history, what's built/verified, and known gaps. `PROGRESS.md` is the single source of truth for current project status — check it before starting new work.

## Repo layout

- `synapse/` - the app (Tauri v2 + React/TS/Vite). See `synapse/README.md`.
- `spikes/` - throwaway proofs of concept, not part of the shipped app. See `spikes/asr-spike/README.md`.
- `synapse_prd.md` - product requirements and architectural rationale.
- `PROGRESS.md` - session handoff log: what's done, what's verified, what's next.

## Commands

All run from `synapse/`:

```bash
npm install
npm approve-scripts esbuild   # one-time, allows esbuild's install script to run
npm run tauri dev             # starts Vite + launches the Tauri app window
npm run tauri build           # production build, produces the NSIS .exe installer on Windows
npm run typecheck             # tsc --noEmit
npm run lint                  # eslint (react-hooks rules are the ones that matter here)
npm run test                  # vitest, the pure modules only
npm run format                # prettier --write over the repo
npm run guards                # repo-specific invariant checks (see below)
```

Rust, from `synapse/src-tauri/`:

```bash
cargo build
cargo test --lib              # unit tests (settings.rs, ai.rs, model_download.rs)
cargo test --lib <test_name>  # run a single test
cargo clippy --all-targets -- -D warnings   # CI runs this; the tree is clean, keep it that way
cargo fmt                     # rustfmt.toml sets max_width = 120 to match the existing style
```

## CI

`.github/workflows/pr.yml` runs on every PR: repo guards, frontend (typecheck/lint/test/build), Rust (clippy `-D warnings` + `cargo test --lib`, on `windows-latest`), formatting, and `cargo audit`. The NSIS installer build is a separate workflow, scoped to PRs touching `src-tauri/` plus manual dispatch, because it takes minutes.

**Prettier is a ratchet, rustfmt is a wall.** The frontend predates Prettier, so CI only checks the `.ts/.tsx/.css/.json/...` files a PR actually touches. Touching one means formatting it — `npm run format` on your own changes.

Rust is no longer scoped that way: the crate is fully rustfmt-clean and CI runs plain `cargo fmt --check`. Run `cargo fmt` before you push. The per-file version was **unfixable, not merely strict** — `rustfmt` follows `mod` declarations, so `rustfmt --check src/lib.rs` re-checks every module in the crate, and stable rustfmt has no `--skip-children` to opt out. That made "changed files only" a fiction: the first PR to touch `lib.rs` inherited the whole tree's formatting debt.

To retire the Prettier ratchet too, on a **clean working tree** (never mixed into feature work — a whitespace-only diff layered on real changes is what makes a PR unreviewable):

```bash
npm run format                                   # from synapse/
git commit -am "chore: apply prettier across the tree"
git rev-parse HEAD >> ../.git-blame-ignore-revs  # keep git blame pointing at authors
```

Then in `.github/workflows/pr.yml`, replace the `formatting` job's Prettier changed-files step with plain `npx prettier --check .`.

**The guards in `scripts/guards/` are the interesting part.** Each one protects an invariant with a _fail-silent_ mode — the kind where the code builds, runs, and quietly does the wrong thing, so neither the compiler nor a test would catch it:

- note colours match between `notes::COLORS` and `noteColors.ts` (backend rejects unknown colours)
- window labels agree across `lib.rs`, `App.tsx` and `capabilities/default.json`, including the `notes-hub` / `note-*` near-collision
- indeterminate meters nest their `-fill` child (a childless track renders as a frozen bar)
- no _new_ raw hex or bare-px spacing in window stylesheets, ratcheted against `css-baseline.json`
- `keyring` declares a native platform store per target (plain `keyring = "3"` compiles the mock and never persists)
- no credential-shaped field in `settings.rs`
- the pocket-tts version and ASR download size the UI states match what Rust pins
- `updater::REPO` names this project's own repository (a wrong one silently runs someone else's installer)

They are grep-shaped, which means they can rot silently — rename a const and the pattern stops matching anything while still reporting "ok". So `scripts/guards/selftest.mjs` breaks each invariant in a copy of the tree and requires the matching guard to complain. CI runs the selftest _before_ the guards. Adding a guard means adding its selftest case.

Windows dev workflow when `npm run tauri dev`'s own output is unreliable to capture: run the Vite dev server and the built exe as two separate processes, redirecting the exe's stdout/stderr to a log file, then read the log after reproducing a bug. See `PROGRESS.md` "Dev workflow" for the exact PowerShell commands.

## Architecture

**Windows are routed by label, not URL hash.** Tauri escapes `#` in `WebviewUrl::App`, so hash-based routing silently fails (every window renders the wheel). `App.tsx` picks which component to render based on the window's label (overlay, notes-hub, clipboard, ai-panel, settings, onboarding). Sticky notes are created at runtime as `note-<id>`, matched by a `startsWith` check _before_ the switch — the label is the only channel that survives, so it carries the note id. `capabilities/default.json` uses a `note-*` glob for them. Careful: `notes-hub` does **not** match `note-` (it's `notes-`), but the two are one character apart.

**Utility windows hide, they don't close.** Notes Hub, Clipboard, AI Panel, and Settings intercept `CloseRequested` and call `hide()` instead of letting Tauri destroy the window — closing a Tauri window destroys it, making it unreusable. Two deliberate exceptions: Onboarding (destroyed on close since it only ever runs once) and individual sticky notes. The rule exists because `show()` on a destroyed window is a silent no-op, which only matters for windows summoned by a _fixed_ label; notes are rebuilt on demand by `open_note_window` (which must check `get_webview_window` first — Tauri panics on a duplicate label), and there are N of them, so hiding would leak a webview per note ever opened.

**Focus model: capture-then-restore, not non-activating windows.** A non-activating overlay (`WS_EX_NOACTIVATE`) was tried first and broke mouse clicks on Windows. The app now calls `GetForegroundWindow()` before showing any window and `SetForegroundWindow()` back before text injection or on dismiss. See PRD §6.1 for the full pivot rationale.

**Settings persistence.** `settings.rs` is a hand-rolled JSON store (not `tauri-plugin-store`); `notes.rs` and `clipboard_history.rs` follow the same shape. `load`/`save` take a `&Path` so they're unit-testable without a Tauri runtime. Unknown/missing fields default gracefully for forward/backward compat as new settings sections get added. A corrupt file falls back to defaults and is backed up to `.bak`. `update_settings` writes the file then broadcasts a `settings-changed` event, since long-lived windows like the AI panel are only ever hidden and won't otherwise notice a change.

**API keys never touch `settings.json`.** They go through the OS keychain via the `keyring` crate (`set_api_key`/`delete_api_key`/`has_api_key`). `keyring` must be declared with the `windows-native`/`apple-native` feature per-target in `Cargo.toml` — plain `keyring = "3"` silently compiles an in-memory mock store that always reports success but never actually persists anything.

**AI chat** streams over raw HTTP + blocking SSE (no official Anthropic/OpenAI Rust SDK exists) via `ai-delta`/`ai-done`/`ai-error` Tauri events. `ai.rs` is a pure HTTP/SSE module with no file I/O, model defaults, or TTS knowledge baked in; `lib.rs`'s `send_ai_message` resolves the model from settings and owns the speech policy through an `on_delta` callback. Conversation history is a `Vec<(role, text)>` in Tauri managed state (`Conversation`), capped at 20 turns and re-sent in full each request.

**Sentence-streamed speech.** `sentences.rs` splits the AI stream into speakable chunks as deltas arrive, so audio starts after the first sentence instead of after the whole reply. It is pure and table-tested. `tts_pocket.rs` queues clips onto **one** long-lived `rodio::Sink` — the audio thread creates its `OutputStream` once and never drops it, because rebuilding per clip (the original design) makes gapless playback impossible. Drain is detected by polling `sink.empty()` **gated on an `EndOfUtterance` marker**, never `sleep_until_end()`: that method is one-shot per sink (rodio takes the receiver and never restores it) and blocking on it would make barge-in impossible. `generation` is per-_utterance_; the sidecar's line-pairing id is a separate `request_seq`.

**Speech-to-text** uses `parakeet-rs` with the Parakeet TDT 0.6B v2 ONNX model (int8, ~630 MB), not checked into the repo. `model_download.rs` is a pure, Tauri-free resumable downloader: `.part` files during download, `Range` requests to resume, rejects truncated downloads, skips if already present. Mic capture via `cpal` resamples the device's native config to 16kHz mono — requesting 16kHz mono directly from the device fails on real hardware. Silence detection is RMS energy thresholding, not ONNX VAD (a planned VAD crate didn't compile against `parakeet-rs`'s `ort` version). **Dictation does not auto-stop by default** — it runs until the user presses Enter or clicks the listening circle. The RMS silence stop is still there but gated behind `settings.voice.auto_stop_on_silence` (default false); the RMS value itself is computed unconditionally because it drives the live level meter (`dictation-tick`). `MAX_RECORD_MS` is 5 minutes and is a runaway guard, not a UX mechanism.

**Text injection** is clipboard paste-and-restore via `enigo` + `tauri-plugin-clipboard-manager`.

**Clipboard history watches by polling `GetClipboardSequenceNumber`**, not `AddClipboardFormatListener` — a listener needs an HWND with a message pump, i.e. subclassing a Tauri window's wndproc, which already failed here once (WRY silently re-subclasses the overlay). Critically, `inject.rs` exposes a `ClipboardGuard` that suppresses the watcher around Synapse's own clipboard writes: `paste_text` writes _twice_ (the injected text, then the restored previous contents), so without it every dictation and paste would be logged back as things the user copied. The guard is a **counter, not a bool** (paste/copy nest in the speak-selected path) plus a 600 ms tail (the OS reports the bump asynchronously, after the function returns) plus a last-write content check.

**Rust source map** (`synapse/src-tauri/src/`): `lib.rs` (orchestration, all Tauri commands and window setup), `asr.rs` (speech-to-text), `inject.rs` (text injection + clipboard-write suppression), `notes.rs` (sticky notes store), `clipboard_history.rs`, `ids.rs`, `screenshot.rs`, `sentences.rs` (speech chunking), `ai.rs`, `settings.rs`, `model_download.rs`, `tts.rs` (OS TTS fallback), `tts_setup.rs` (installs the optional local voice engine), `tts_pocket.rs` (pocket-tts sidecar protocol + audio queue), `updater.rs` (in-app updates).

**In-app updates run an executable, so the URL never comes from the webview.** `updater.rs` reads the latest release from the GitHub API for `updater::REPO`, downloads the NSIS installer, and runs it silently — which makes the download target a code-execution channel, not just a URL. So `download_update` takes **no arguments**: it re-resolves the release server-side rather than accepting a URL from the frontend, because any script in a Synapse window (the AI panel renders model output, notes render user text) could otherwise pick the binary that gets executed. `is_allowed_asset_url` pins the host to GitHub's on top of that. There is no signature check — HTTPS to github.com is the whole trust chain, which is why `REPO` pointing at the right repository is load-bearing.

Two things about the install itself are easy to get wrong. NSIS's `/S` suppresses the finish page **and its "Run Synapse" checkbox**, so the relaunch is chained explicitly through `cmd` — without it the app just vanishes on update and reads as a crash. And `installer/hooks.nsh` drops the `.fresh-install` marker on _every_ install, upgrades included, so `launch_installer` leaves a `.update-pending` marker that `run()` uses to tell an upgrade from a first install; without it every update would dump the user back into the onboarding wizard.

**Frontend source map** (`synapse/src/`): `App.tsx` (router by window label), `Wheel.tsx` + `wedges.ts` (radial menu), `NotesHub.tsx` + `StickyNote.tsx` + `noteColors.ts`, `Clipboard.tsx`, `AiPanel.tsx` (the voice orb), `Settings.tsx` + `settings/` (per-section components), `Onboarding.tsx`, `theme.css` (the design system — every other stylesheet `@import`s it), `modelDownload.ts` (shared download-progress hook used by both onboarding and Settings → Voice), `ttsSetup.ts` (stage-aware voice-engine setup hook, same two consumers), `models.ts` (shared `Provider`/`Settings` types, model catalog, and the user-facing `ASR_MODEL`/`TTS_ENGINE` names).

**One design system, in `theme.css`.** Colour, spacing, type, radius, elevation and motion are all tokens there; window stylesheets must not type raw hex values or bare pixel gaps. Before it existed the same background was retyped in four files and error red existed in three shades. Two rules from it are easy to break: declare elevation **once** (a border or a shadow, never both), and keep note colours in `noteColors.ts` in step with `notes::COLORS` in Rust — the backend rejects any colour it doesn't know.

**Indeterminate progress meters need a fill child.** Both meter styles animate via a _descendant_ selector (`.ob-meter-idle .ob-meter-fill`, `.set-meter-idle .set-meter-fill`). Rendering the track as a childless `<div className="ob-meter ob-meter-idle" />` produces a permanently frozen empty bar that users read as a hang — always nest the `-fill` div, even when there's no percentage to show.

## Platform notes

- Dev machine is Windows-only. Every macOS-specific code path (`tauri-nspanel`, vibrancy, Gatekeeper/TCC behavior, `#[cfg(target_os = "macos")]`) is written but completely untested. Treat any macOS claim as unverified until run on real hardware.
- Windows Smart App Control can block Cargo build-script binaries (`os error 4551`). If builds start failing that way, check Settings → Privacy & security → Windows Security → App & browser control.
