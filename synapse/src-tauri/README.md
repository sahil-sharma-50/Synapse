# src-tauri

Rust backend for the Synapse Tauri app.

## Source files

- `lib.rs` - orchestration: all Tauri commands, window setup, hotkey handling, the overlay/focus lifecycle.
- `main.rs` - entry point, calls into `lib.rs`.
- `asr.rs` - speech-to-text via `parakeet-rs`, mic capture and resampling via `cpal`.
- `ai.rs` - AI chat, raw HTTP + blocking SSE for Anthropic and OpenAI, no file I/O.
- `settings.rs` - JSON settings store, `load`/`save` take a `&Path` so they're unit-testable.
- `model_download.rs` - resumable ASR model downloader, pure and Tauri-free.
- `inject.rs` - clipboard paste-and-restore text injection via `enigo`.
- `notes.rs` - Notepad scratchpad persistence.
- `screenshot.rs` - screenshot capture via `xcap`, pinned to 0.9 (0.3 has a different API).
- `snippets.rs` - saved text snippet CRUD.
- `tts.rs` - OS text-to-speech, the always-available fallback voice.
- `tts_setup.rs` - one-time setup for the optional local voice engine: downloads a standalone Python runtime, pip-installs `torch` (CPU) + `pocket-tts`, pre-warms the model weights, then writes a `READY` marker. Emits `tts-setup-progress`/`-done`/`-error`.
- `tts_pocket.rs` - runs the `pocket-tts` Python sidecar over a line-delimited JSON stdin/stdout protocol.

## Commands

```bash
cargo build
cargo test --lib              # unit tests: settings, ai, model_download, inject, tts_setup, tts_pocket, lib
cargo test --lib <test_name>  # run a single test
```

## Notes

- `keyring` must keep its `windows-native` (Windows) / `apple-native` (macOS) feature in `Cargo.toml`. Without it, `keyring` silently uses an in-memory mock store: API key saves report success but never actually persist.
- The ASR model (Parakeet TDT 0.6B v2, int8 ONNX, ~630 MB) is not checked in. It downloads into `model/` on first run via `model_download.rs`; `model/` is gitignored.
- The optional local voice engine is not checked in either. `tts_setup.rs` installs it under `app_data_dir()/tts-env/` (`%APPDATA%\com.synapse.app\tts-env\` on Windows) and treats the `READY` marker file as the single source of truth for "is setup complete" — delete that file to force a re-run.
- See the root `CLAUDE.md` for the fuller architecture picture (window routing, focus model, settings broadcast pattern).
