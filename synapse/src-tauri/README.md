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
- `tts.rs` - text-to-speech.

## Commands

```bash
cargo build
cargo test --lib              # settings.rs, ai.rs, model_download.rs unit tests
cargo test --lib <test_name>  # run a single test
```

## Notes

- `keyring` must keep its `windows-native` (Windows) / `apple-native` (macOS) feature in `Cargo.toml`. Without it, `keyring` silently uses an in-memory mock store: API key saves report success but never actually persist.
- The ASR model (Parakeet TDT 0.6B v2, int8 ONNX, ~630 MB) is not checked in. It downloads into `model/` on first run via `model_download.rs`; `model/` is gitignored.
- See the root `CLAUDE.md` for the fuller architecture picture (window routing, focus model, settings broadcast pattern).
