# Rust backend

Tauri commands and desktop integration for Synapse. See the root [AGENTS.md](../../AGENTS.md) for architecture and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full check list.

## Source map

- `lib.rs` — command registration, window lifecycle, shortcuts, and orchestration.
- `asr.rs`, `model_download.rs` — local dictation and resumable ASR model download.
- `ai.rs`, `ai_history.rs`, `ai_usage.rs`, `desktop.rs`, `hybrid.rs` — provider requests, conversation and usage storage, and assisted desktop actions.
- `notes.rs`, `clipboard_history.rs`, `storage.rs` — notes, clipboard history, and SQLite storage.
- `inject.rs`, `screenshot.rs` — focus-aware text insertion and screen capture.
- `sentences.rs`, `tts.rs`, `tts_setup.rs`, `tts_pocket.rs` — speech chunking, OS voice fallback, optional local voice setup, and playback.
- `settings.rs`, `updater.rs` — preferences, keychain-backed credentials, and signed in-app updates.

## Checks

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

The ASR model and optional voice engine download into the user's app data directory; neither belongs in Git. Keep `keyring`'s native platform features and the official `tauri-plugin-updater` signature verification path. Pull request installer builds use `tauri.pr-build.conf.json` without signing; only the maintainer's release workflow can sign updater artifacts.
