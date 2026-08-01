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
npx tsc --noEmit              # typecheck frontend
```

Rust, from `synapse/src-tauri/`:

```bash
cargo build
cargo test --lib              # unit tests (settings.rs, ai.rs, model_download.rs)
cargo test --lib <test_name>  # run a single test
```

Windows dev workflow when `npm run tauri dev`'s own output is unreliable to capture: run the Vite dev server and the built exe as two separate processes, redirecting the exe's stdout/stderr to a log file, then read the log after reproducing a bug. See `PROGRESS.md` "Dev workflow" for the exact PowerShell commands.

## Architecture

**Windows are routed by label, not URL hash.** Tauri escapes `#` in `WebviewUrl::App`, so hash-based routing silently fails (every window renders the wheel). `App.tsx` picks which component to render based on the window's label (overlay, notepad, snippet, ai, settings, onboarding).

**Utility windows hide, they don't close.** Notepad, Snippet Picker, AI Panel, and Settings intercept `CloseRequested` and call `hide()` instead of letting Tauri destroy the window — closing a Tauri window destroys it, making it unreusable. Onboarding is the one exception: it's destroyed on close since it only ever runs once.

**Focus model: capture-then-restore, not non-activating windows.** A non-activating overlay (`WS_EX_NOACTIVATE`) was tried first and broke mouse clicks on Windows. The app now calls `GetForegroundWindow()` before showing any window and `SetForegroundWindow()` back before text injection or on dismiss. See PRD §6.1 for the full pivot rationale.

**Settings persistence.** `settings.rs` is a hand-rolled JSON store (not `tauri-plugin-store`), mirroring `snippets.rs`'s pattern. `load`/`save` take a `&Path` so they're unit-testable without a Tauri runtime. Unknown/missing fields default gracefully for forward/backward compat as new settings sections get added. A corrupt file falls back to defaults and is backed up to `.bak`. `update_settings` writes the file then broadcasts a `settings-changed` event, since long-lived windows like the AI panel are only ever hidden and won't otherwise notice a change.

**API keys never touch `settings.json`.** They go through the OS keychain via the `keyring` crate (`set_api_key`/`delete_api_key`/`has_api_key`). `keyring` must be declared with the `windows-native`/`apple-native` feature per-target in `Cargo.toml` — plain `keyring = "3"` silently compiles an in-memory mock store that always reports success but never actually persists anything.

**AI chat** streams over raw HTTP + blocking SSE (no official Anthropic/OpenAI Rust SDK exists) via `ai-delta`/`ai-done`/`ai-error` Tauri events. `ai.rs` is a pure HTTP/SSE module with no file I/O or model defaults baked in; `lib.rs`'s `send_ai_message` resolves the model from settings before calling it.

**Speech-to-text** uses `parakeet-rs` with the Parakeet TDT 0.6B v2 ONNX model (int8, ~630 MB), not checked into the repo. `model_download.rs` is a pure, Tauri-free resumable downloader: `.part` files during download, `Range` requests to resume, rejects truncated downloads, skips if already present. Mic capture via `cpal` resamples the device's native config to 16kHz mono — requesting 16kHz mono directly from the device fails on real hardware. Silence detection is RMS energy thresholding, not ONNX VAD (a planned VAD crate didn't compile against `parakeet-rs`'s `ort` version).

**Text injection** is clipboard paste-and-restore via `enigo` + `tauri-plugin-clipboard-manager`.

**Rust source map** (`synapse/src-tauri/src/`): `lib.rs` (orchestration, all Tauri commands and window setup), `asr.rs` (speech-to-text), `inject.rs` (text injection), `notes.rs`, `screenshot.rs`, `snippets.rs`, `ai.rs`, `settings.rs`, `model_download.rs`, `tts.rs` (OS TTS fallback), `tts_setup.rs` (installs the optional local voice engine), `tts_pocket.rs` (pocket-tts Python sidecar protocol).

**Frontend source map** (`synapse/src/`): `App.tsx` (router by window label), `Wheel.tsx` + `wedges.ts` (radial menu), `Notepad.tsx`, `SnippetPicker.tsx`, `AiPanel.tsx`, `Settings.tsx` + `settings/` (per-section components), `Onboarding.tsx`, `modelDownload.ts` (shared download-progress hook used by both onboarding and Settings → Voice), `ttsSetup.ts` (stage-aware voice-engine setup hook, same two consumers), `models.ts` (shared `Provider`/`Settings` types and model catalog).

**Indeterminate progress meters need a fill child.** Both meter styles animate via a *descendant* selector (`.ob-meter-idle .ob-meter-fill`, `.set-meter-idle .set-meter-fill`). Rendering the track as a childless `<div className="ob-meter ob-meter-idle" />` produces a permanently frozen empty bar that users read as a hang — always nest the `-fill` div, even when there's no percentage to show.

## Platform notes

- Dev machine is Windows-only. Every macOS-specific code path (`tauri-nspanel`, vibrancy, Gatekeeper/TCC behavior, `#[cfg(target_os = "macos")]`) is written but completely untested. Treat any macOS claim as unverified until run on real hardware.
- Windows Smart App Control can block Cargo build-script binaries (`os error 4551`). If builds start failing that way, check Settings → Privacy & security → Windows Security → App & browser control.
