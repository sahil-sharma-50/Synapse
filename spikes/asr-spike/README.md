# asr-spike

Throwaway proof of concept for speech-to-text. Not part of the shipped app, not wired into `synapse/`.

Proved out `parakeet-rs` transcription: 1.2s model load, 0.29s to transcribe 11s of audio, CPU-only, word-perfect on `jfk.wav`. The result of this spike is what `synapse/src-tauri/src/asr.rs` builds on.

## Run

```bash
cargo run
```

Needs an ONNX model in `model/` (gitignored, download separately) and `jfk.wav` as sample input.
