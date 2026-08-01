# Speak Selected Text — Design

Date: 2026-08-01
Status: Approved for planning

## Summary

Add a "Speak Selected Text" action to the radial wheel: the user selects text in any application, opens the wheel, picks the new action, and Synapse reads the selection aloud. TTS is powered by [pocket-tts](https://github.com/kyutai-labs/pocket-tts) (Kyutai, MIT, 100M params, CPU-only, Python/PyTorch), run via a bundled Python sidecar process. Pocket-tts also replaces the existing OS-native TTS (`tts.rs`) as the engine behind the app's existing `speak_text` command (used to read AI responses aloud), with automatic fallback to OS-native TTS whenever the pocket-tts engine isn't downloaded yet or its sidecar is unavailable.

## Why a Python sidecar

Pocket-tts has no official Rust or C bindings — it's a Python/PyTorch package. Synapse's backend is otherwise pure Rust, and the existing STT feature deliberately uses a Rust-native ONNX model (`parakeet-rs`) to avoid exactly this kind of runtime dependency. Community Rust ports (Candle-based) exist but are unofficial/unvetted, so this design bundles a real Python environment instead of depending on one.

Pocket-tts's own `serve` command starts an HTTP server, but it's built for its browser demo and its request/response contract isn't documented for embedding. Spawning a fresh Python process per utterance would also reload the model (torch import + weight load) on every request. Instead, Synapse spawns and owns a small wrapper script (written by us, not upstream) as a **long-lived sidecar process**: it loads the model once, then services requests over stdin/stdout for the lifetime of the app (spawned lazily on first use, not at startup).

## Text capture

`inject.rs` today only pastes (writes clipboard, sends Ctrl+V); there's no existing "read the current selection" path. This adds one, following the same capture-then-restore spirit as the existing paste/focus code:

1. `select_wedge`'s new `"speak-selected"` arm hides the overlay and waits ~180ms (same pattern as the `"screenshot"` arm, to let the compositor clear the wheel before acting).
2. Restore focus to the previously-foregrounded window via the existing `restore_previous_focus`.
3. Save current clipboard contents.
4. Simulate Ctrl+C via `enigo` (new — no copy simulation exists in the codebase today).
5. Read the clipboard.
6. Restore the clipboard to its saved contents.
7. If the read-back text is empty or identical to what the clipboard held before step 4 (nothing was selected), show a toast ("No text selected") and stop.
8. Otherwise pass the text into the shared speak path (below).

## TTS sidecar protocol

Newline-delimited JSON over stdin/stdout — no binary framing on the same stream, since Python's own logging could otherwise pollute stdout.

- Request (Rust → sidecar): `{"id": <u64>, "text": "<string>", "voice": "<preset name>", "out_path": "<absolute path>"}`
- Response (sidecar → Rust): `{"id": <u64>, "status": "ok"}` or `{"id": <u64>, "status": "error", "message": "<string>"}`

The sidecar loads the model at startup, then loops reading one request per line, synthesizing to `out_path` (a Rust-generated temp WAV path), and writing one response line.

### Interrupt behavior

Rust (new `tts_pocket.rs`) tracks a monotonically increasing request generation counter and the current `rodio::Sink`:

- On any new speak request: stop the current `Sink` immediately (cuts off in-progress playback), increment the generation, send the new request to the sidecar.
- If a response arrives whose `id` doesn't match the latest generation, it's discarded (the request it answers was superseded) — its temp WAV is deleted without playing.
- On a matching response: play `out_path` via `rodio`, then delete the temp file.

### Process lifecycle

- Spawned lazily on the first speak request after app start (not eagerly at startup) — avoids permanently holding a Python+torch process in memory for a feature that may go unused in a session.
- If the process is found dead (write fails / stdout pipe closed) on a request: log it, fall back to OS-native TTS for that request, and respawn lazily on the next request.

## Engine selection in `speak_text`

The existing `speak_text` Tauri command (used both by the new wheel action and the AI panel's existing "read response aloud" button — no frontend change needed there) becomes:

1. If the pocket-tts environment is downloaded and the sidecar is reachable, route through `tts_pocket`.
2. Otherwise, fall back to the existing OS-native `tts::speak` (SAPI on Windows / `say` on macOS).

This fallback also covers mid-session sidecar crashes and setup failures — the feature always produces speech, just with the OS voice until pocket-tts is available.

## Packaging & download

`model_download.rs` is hardcoded to a single asset (the Parakeet ASR model's flat file list). Rather than generalize it into an abstract multi-model framework for just two assets, this design:

- Extracts the reusable low-level piece — resumable chunked download with `.part` files and `Range`-based resume — into a small shared helper usable by both the existing ASR downloader and the new TTS setup.
- Adds a sibling module, `tts_setup.rs`, with its own orchestration and its own Tauri events (`tts-setup-progress`, `tts-setup-done`, `tts-setup-error`), since its stages are qualitatively different from a flat file list:
  1. Download a standalone embeddable Python runtime for the host platform (via `python-build-standalone` releases — MIT-compatible, redistributable, has both Windows and macOS builds).
  2. Extract it to `app_data_dir()/pyenv/`.
  3. Run its bundled `pip` to install `torch` (CPU wheel) and `pocket-tts` — the bulk of the download, realistically several hundred MB to ~1GB.
  4. Pre-warm the voice/model weights by invoking the wrapper script once with a throwaway request during setup (pocket-tts pulls weights from Hugging Face on first load; doing this during setup means the first real "speak" isn't the one paying for it).
- `tts-setup-progress` carries a stage label (`"python" | "packages" | "weights"`) alongside byte counters, since stage 3 dwarfs the others and a single blended percentage would be misleading.
- On setup failure at any stage, the partial `pyenv/` is left in place (not cleaned up) and setup can be retried — pip install is idempotent and the Python runtime download can resume via the same `.part`-file logic as the ASR downloader.

Total download size is realistically 1-2GB.

## UI changes

**Wheel** (`wedges.ts`, `Wheel.tsx`): add a `"speak-selected"` wedge ("Speak Selected Text") to the flat ring; the ring layout is computed from wedge count so no layout changes are needed.

**Settings → Voice** (`VoiceSection.tsx`): add a second row below the existing STT model row, reusing the same download-button/progress-meter markup:
- "Text-to-Speech engine" with its own download button and staged progress meter (label per stage, from `tts-setup-progress`).
- A voice dropdown (static list of pocket-tts's ~25 preset voice names, e.g. alba, giovanni, lola), disabled until the engine is downloaded. Selected voice is persisted in `settings.json` (not a secret, so no keychain involvement) and sent as the `voice` field in sidecar requests.

**Onboarding** (`Onboarding.tsx`): add a second step after the existing (required) ASR model step: "Download voice speech engine (~1-2GB, optional)" with a **Skip, download later from Settings** action. Optional and skippable — forcing a multi-GB wait on first run for a secondary feature would hurt onboarding completion; the existing ASR download stays required since it's core to the app's dictation identity.

## Error handling

| Condition | Behavior |
|---|---|
| TTS env not downloaded | Fall back to OS-native TTS transparently |
| Sidecar process dead | Log, fall back to OS-native TTS for that request, respawn lazily next time |
| Nothing selected (clipboard unchanged) | Toast "No text selected", no speech attempt |
| Setup download/install fails | `tts-setup-error` surfaces in Settings; partial state left for retry |
| Stale sidecar response (superseded by newer request) | Discarded, temp WAV deleted unplayed |

## Testing

- Rust unit tests (`cargo test --lib`): sidecar request/response JSON (de)serialization; generation-counter interrupt logic (stale responses discarded); clipboard capture-then-restore round trip (clipboard get/set mocked, no live selection needed).
- Manual verification on the Windows dev machine (per this repo's platform constraints): select text in another app and trigger the wheel action end-to-end; verify interrupting mid-speech with a second trigger; verify the Settings download flow end-to-end including staged progress; verify OS-native fallback behavior when the TTS env isn't downloaded.
- No automated audio-output verification exists in this repo (no infra for it) — playback correctness is manual/listening-based.

## Out of scope

- Any change to the AI panel's "read response aloud" *UI* — it already calls `speak_text`; only the backend engine selection changes.
- Non-English voice/language selection beyond exposing the preset list (no translation, no language auto-detection).
- macOS-specific verification of any part of this feature — consistent with the rest of the repo, macOS code paths are written but untested on real hardware.
