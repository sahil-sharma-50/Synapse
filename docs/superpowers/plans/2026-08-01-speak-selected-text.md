# Speak Selected Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Speak Selected Text" wheel action that reads the user's current OS text selection aloud via a bundled pocket-tts (Kyutai) Python sidecar, with the existing OS-native TTS as a transparent fallback, plus the Settings/onboarding UI to download the engine.

**Architecture:** A long-lived Python sidecar process (spawned lazily, owned by Rust) does the actual synthesis; Rust talks to it over a newline-delimited JSON stdin/stdout protocol and plays the resulting WAV via `rodio`. A new `tts_setup.rs` module downloads an embeddable Python runtime, pip-installs `torch` + `pocket-tts` into it, and pre-warms the model weights — reusing the existing resumable-download helper (`model_download::download_one_file`) rather than duplicating it. The existing `speak_text` command (already used by the AI panel) routes through the sidecar when it's ready and falls back to the existing OS-native `tts::speak` otherwise.

**Tech Stack:** Rust (Tauri v2 backend), React/TypeScript (frontend), Python 3 + PyTorch (CPU) + pocket-tts (bundled sidecar, not a build-time dependency of the Rust crate).

## Global Constraints

- API keys/secrets never touch `settings.json` — not applicable to this feature (no secrets involved), but any new settings fields must follow the existing `#[serde(default = ...)]` forward/backward-compat pattern in `settings.rs`.
- `load`/`save`-style functions must take a `&Path`, not an `AppHandle`, so they're unit-testable without a Tauri runtime (per `settings.rs`/`model_download.rs` precedent).
- Windows is the only verified platform; any macOS-specific code path is written best-effort and explicitly called out as untested, matching the rest of the repo.
- Reuse `model_download::download_one_file` / `remote_file_size` for any new resumable download rather than reimplementing chunked/`.part`-file download logic.
- New Tauri commands/events follow existing naming: commands `snake_case`, events `kebab-case` (e.g. `tts-setup-progress`).

---

## File Structure

- `synapse/src-tauri/src/inject.rs` — **modify**: add `copy_selection` (simulate Ctrl+C, read clipboard, restore it).
- `synapse/src-tauri/src/tts_pocket.rs` — **create**: sidecar protocol (request/response types, encode/decode, generation-counter interrupt check), process lifecycle (spawn/respawn), playback via `rodio`.
- `synapse/src-tauri/resources/tts_sidecar.py` — **create**: the Python script the sidecar process runs (loads pocket-tts once, services stdin/stdout requests).
- `synapse/src-tauri/src/tts_setup.rs` — **create**: downloads the embeddable Python runtime, installs `torch`/`pocket-tts`, pre-warms model weights; emits `tts-setup-*` events.
- `synapse/src-tauri/src/tts.rs` — **modify**: no change to `speak` itself; `lib.rs`'s `speak_text` gains the routing logic (kept there since it already owns provider/model resolution for the AI panel's use of this command).
- `synapse/src-tauri/src/settings.rs` — **modify**: add `TtsSettings { voice: String }` section.
- `synapse/src-tauri/src/lib.rs` — **modify**: wire `copy_selection` into `select_wedge`'s `"speak-selected"` arm, add `tts_setup_status`/`download_tts_engine`/`list_tts_voices` commands, update `speak_text` to route through `tts_pocket` when ready.
- `synapse/src-tauri/Cargo.toml` — **modify**: add `rodio` dependency.
- `synapse/src-tauri/tauri.conf.json` — **modify**: bundle `resources/tts_sidecar.py`.
- `synapse/src/wedges.ts` — **modify**: add the `"speak-selected"` wedge.
- `synapse/src/models.ts` — **modify**: add `TtsSettings` type, extend `Settings`.
- `synapse/src/ttsSetup.ts` — **create**: `useTtsSetup()` hook, sibling to `modelDownload.ts`'s `useModelDownload()` but stage-aware.
- `synapse/src/settings/VoiceSection.tsx` — **modify**: add the TTS engine download row + voice dropdown.
- `synapse/src/Onboarding.tsx` — **modify**: add an optional `"voice-engine"` step.

---

### Task 1: Investigate the pocket-tts Python API and the current python-build-standalone release

This is a research spike, not a coding task — two genuine unknowns block writing correct code in later tasks: pocket-tts's Python library surface (only its CLI is documented) and the current python-build-standalone release asset naming (these change over time).

**Files:**
- Create: `docs/superpowers/plans/2026-08-01-pocket-tts-api-notes.md`

- [ ] **Step 1: Install pocket-tts locally and inspect its Python API**

```bash
python -m venv /tmp/pocket-tts-spike
/tmp/pocket-tts-spike/bin/pip install pocket-tts   # or Scripts\pip.exe on Windows
/tmp/pocket-tts-spike/bin/python -c "import pocket_tts; help(pocket_tts)"
```

Find the class/function that: (a) loads the model once and can be reused across multiple `generate` calls without reloading, and (b) accepts `text` + a voice name/path and returns audio you can write to a WAV file (either raw samples + sample rate, or a helper that writes the file directly). Note the exact import path, class name, constructor args, and method signature.

- [ ] **Step 2: Find the current python-build-standalone Windows release**

Check `https://github.com/astral-sh/python-build-standalone/releases` for the latest release tag and the exact asset filename for `x86_64-pc-windows-msvc` with the `install_only` variant (this is the redistributable, pip-included build). Note the full download URL.

- [ ] **Step 3: Write findings**

```markdown
# pocket-tts / python-build-standalone integration notes

## pocket-tts Python API
- Import: `from pocket_tts import <ClassName>`
- Load once: `<ClassName>(...)`
- Synthesize: `<method>(text: str, voice: str) -> <return type>`
- How to get WAV bytes/samples from the return value: ...

## python-build-standalone
- Release tag: <tag>
- Windows asset URL: <full URL>
- Archive layout (where python.exe / pip live after extraction): ...
```

Fill in the actual values found in Steps 1-2. Task 4 and Task 8 below use placeholder values (`<PYTHON_TTS_CLASS>`, `<PYTHON_BUILD_STANDALONE_URL>`) that must be replaced with these real findings before those tasks are implemented — do not proceed on the placeholders as-is.

- [ ] **Step 4: Commit the notes**

```bash
git add docs/superpowers/plans/2026-08-01-pocket-tts-api-notes.md
git commit -m "docs: record pocket-tts API and python-build-standalone release findings"
```

---

### Task 2: Add `TtsSettings` to `settings.rs`

**Files:**
- Modify: `synapse/src-tauri/src/settings.rs`

**Interfaces:**
- Produces: `pub struct TtsSettings { pub voice: String }`, `Settings.tts: TtsSettings`, default voice `"alba"`.

- [ ] **Step 1: Write the failing test**

Add to `synapse/src-tauri/src/settings.rs`'s `mod tests`:

```rust
#[test]
fn tts_voice_defaults_and_persists() {
    let path = temp_dir("tts-voice").join("settings.json");

    let mut settings = load(&path);
    assert_eq!(settings.tts.voice, "alba", "defaults to alba for a fresh install");

    settings.tts.voice = "giovanni".to_string();
    save(&path, &settings).expect("save settings");

    let reloaded = load(&path);
    assert_eq!(reloaded.tts.voice, "giovanni", "persists across a reload");
}

#[test]
fn tts_settings_missing_from_file_defaults_gracefully() {
    let path = temp_dir("tts-missing").join("settings.json");
    std::fs::write(&path, r#"{"ai":{"provider":"anthropic"}}"#).expect("write settings");

    let settings = load(&path);
    assert_eq!(settings.tts.voice, "alba", "missing tts section defaults, does not fail parse");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `synapse/src-tauri/`): `cargo test --lib tts_voice_defaults_and_persists`
Expected: FAIL with "no field `tts` on type `Settings`" (compile error).

- [ ] **Step 3: Add `TtsSettings` and wire it into `Settings`**

In `synapse/src-tauri/src/settings.rs`, add near `AiSettings`:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct TtsSettings {
    #[serde(default = "default_voice")]
    pub voice: String,
}

fn default_voice() -> String {
    "alba".to_string()
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self { voice: default_voice() }
    }
}
```

And add the field to `Settings`:

```rust
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub tts: TtsSettings,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib tts_voice`
Expected: PASS (both new tests).

- [ ] **Step 5: Commit**

```bash
git add synapse/src-tauri/src/settings.rs
git commit -m "feat: add tts.voice setting"
```

---

### Task 3: Selected-text capture in `inject.rs`

**Files:**
- Modify: `synapse/src-tauri/src/inject.rs`

**Interfaces:**
- Produces: `pub fn copy_selection(app: &tauri::AppHandle) -> Result<Option<String>, String>` — `Ok(Some(text))` when a selection was captured, `Ok(None)` when nothing new was copied (clipboard unchanged), restores the clipboard to its prior contents either way (when there was a prior value).

- [ ] **Step 1: Write the failing test**

Add to `synapse/src-tauri/src/inject.rs` (new `#[cfg(test)] mod tests` block — `paste_text`/`copy_selection` both need a live `enigo`/clipboard, which isn't available in a headless test run, so this test targets the pure decision logic instead, extracted as its own function):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_result_is_none_when_clipboard_unchanged() {
        let previous = Some("hello".to_string());
        let captured = Some("hello".to_string());
        assert_eq!(resolve_selection(previous, captured), None);
    }

    #[test]
    fn selection_result_is_none_when_captured_is_empty() {
        let previous = Some("hello".to_string());
        let captured = Some(String::new());
        assert_eq!(resolve_selection(previous, captured), None);
    }

    #[test]
    fn selection_result_is_some_when_clipboard_changed() {
        let previous = Some("hello".to_string());
        let captured = Some("world".to_string());
        assert_eq!(resolve_selection(previous, captured), Some("world".to_string()));
    }

    #[test]
    fn selection_result_is_some_when_clipboard_was_previously_empty() {
        let previous = None;
        let captured = Some("world".to_string());
        assert_eq!(resolve_selection(previous, captured), Some("world".to_string()));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `synapse/src-tauri/`): `cargo test --lib resolve_selection`
Expected: FAIL with "cannot find function `resolve_selection`".

- [ ] **Step 3: Implement `resolve_selection` and `copy_selection`**

Add to `synapse/src-tauri/src/inject.rs`:

```rust
/// Pure decision logic behind `copy_selection`, split out so it's testable
/// without a live clipboard/enigo: `None` means "treat this as no selection"
/// (nothing new was copied), `Some` is the text to speak.
fn resolve_selection(previous: Option<String>, captured: Option<String>) -> Option<String> {
    match captured {
        Some(text) if !text.is_empty() && Some(&text) != previous.as_ref() => Some(text),
        _ => None,
    }
}

/// Simulates Ctrl+C to capture whatever text is currently selected in the
/// foreground window, then restores the clipboard to what it held before —
/// same capture-then-restore spirit as `paste_text`'s clipboard restore.
/// Caller is responsible for making sure the intended source window already
/// has focus before calling this (mirrors `paste_text`'s contract).
pub fn copy_selection(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let clipboard = app.clipboard();
    let previous = clipboard.read_text().ok();

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("{e:?}"))?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| format!("{e:?}"))?;
    enigo.key(Key::Unicode('c'), Direction::Click).map_err(|e| format!("{e:?}"))?;
    enigo.key(modifier, Direction::Release).map_err(|e| format!("{e:?}"))?;

    std::thread::sleep(std::time::Duration::from_millis(80));

    let captured = clipboard.read_text().ok();
    let result = resolve_selection(previous.clone(), captured);

    if let Some(prev) = previous {
        let _ = clipboard.write_text(prev);
    }

    Ok(result)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib resolve_selection`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add synapse/src-tauri/src/inject.rs
git commit -m "feat: add selected-text capture via simulated copy"
```

---

### Task 4: `tts_pocket.rs` — sidecar protocol and interrupt logic (pure, unit-tested)

Splits the parts of the sidecar integration that are pure logic (and thus unit-testable) from the parts that need a live process/audio device (Task 5, manually verified). This task has no Python or audio dependency.

**Files:**
- Create: `synapse/src-tauri/src/tts_pocket.rs`
- Modify: `synapse/src-tauri/src/lib.rs:1-9` (add `mod tts_pocket;`)

**Interfaces:**
- Produces: `pub struct SidecarRequest { pub id: u64, pub text: String, pub voice: String, pub out_path: String }` (Serialize), `pub struct SidecarResponse { pub id: u64, pub status: String, pub message: Option<String> }` (Deserialize), `pub fn encode_request(req: &SidecarRequest) -> String`, `pub fn decode_response(line: &str) -> Result<SidecarResponse, String>`, `pub fn is_current(response_id: u64, generation: u64) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `synapse/src-tauri/src/tts_pocket.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Debug, PartialEq)]
pub struct SidecarRequest {
    pub id: u64,
    pub text: String,
    pub voice: String,
    pub out_path: String,
}

#[derive(Deserialize, Debug, PartialEq)]
pub struct SidecarResponse {
    pub id: u64,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

/// One JSON object per line on the sidecar's stdin — no trailing newline
/// baked in, the caller writing to the child process appends it.
pub fn encode_request(req: &SidecarRequest) -> String {
    serde_json::to_string(req).expect("SidecarRequest always serializes")
}

pub fn decode_response(line: &str) -> Result<SidecarResponse, String> {
    serde_json::from_str(line).map_err(|e| format!("bad sidecar response: {e}"))
}

/// True when `response_id` answers the most recently sent request. A `false`
/// means the response was superseded by a newer speak request while the
/// sidecar was still working — the caller should discard it (and delete its
/// temp WAV) instead of playing stale audio.
pub fn is_current(response_id: u64, generation: u64) -> bool {
    response_id == generation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_request_as_single_line_json() {
        let req = SidecarRequest {
            id: 1,
            text: "hello".to_string(),
            voice: "alba".to_string(),
            out_path: "C:\\tmp\\tts_1.wav".to_string(),
        };
        let line = encode_request(&req);
        assert!(!line.contains('\n'), "request must be a single line");
        assert!(line.contains("\"id\":1"));
        assert!(line.contains("\"voice\":\"alba\""));
    }

    #[test]
    fn decodes_ok_response() {
        let response = decode_response(r#"{"id":2,"status":"ok"}"#).expect("valid response");
        assert_eq!(response.id, 2);
        assert_eq!(response.status, "ok");
        assert_eq!(response.message, None);
    }

    #[test]
    fn decodes_error_response_with_message() {
        let response =
            decode_response(r#"{"id":3,"status":"error","message":"boom"}"#).expect("valid response");
        assert_eq!(response.status, "error");
        assert_eq!(response.message, Some("boom".to_string()));
    }

    #[test]
    fn rejects_malformed_response() {
        assert!(decode_response("not json").is_err());
    }

    #[test]
    fn current_response_matches_latest_generation() {
        assert!(is_current(5, 5));
    }

    #[test]
    fn stale_response_does_not_match_newer_generation() {
        assert!(!is_current(4, 5), "a response to an older request must not be treated as current");
    }
}
```

- [ ] **Step 2: Register the module and run tests**

In `synapse/src-tauri/src/lib.rs`, add `mod tts_pocket;` next to the other `mod` declarations (line 1-9 block).

Run (from `synapse/src-tauri/`): `cargo test --lib tts_pocket::`
Expected: PASS (6 tests) once the module compiles.

- [ ] **Step 3: Commit**

```bash
git add synapse/src-tauri/src/tts_pocket.rs synapse/src-tauri/src/lib.rs
git commit -m "feat: add pocket-tts sidecar protocol encode/decode and interrupt check"
```

---

### Task 5: `tts_pocket.rs` — process lifecycle and playback (manual verification)

Builds on Task 4's pure functions to actually spawn the sidecar, send/receive over its pipes, and play the result. This can't be exercised in an automated test without a real Python environment and audio device, so verification here is manual (per the design doc's testing section — no audio-output test infra exists in this repo).

**Files:**
- Modify: `synapse/src-tauri/src/tts_pocket.rs`
- Modify: `synapse/src-tauri/Cargo.toml` (add `rodio`)

**Interfaces:**
- Consumes: `SidecarRequest`, `SidecarResponse`, `encode_request`, `decode_response`, `is_current` (Task 4).
- Produces: `pub struct TtsSidecar` with `pub fn new() -> Self` and `pub fn speak(&self, app: &tauri::AppHandle, sidecar_path: &std::path::Path, python_path: &std::path::Path, text: &str, voice: &str) -> Result<(), String>` — stops any in-progress playback, spawns/reuses the child process, sends the request, plays the response.

- [ ] **Step 1: Add the `rodio` dependency**

In `synapse/src-tauri/Cargo.toml`, under `[dependencies]`:

```toml
rodio = "0.19"
```

Run (from `synapse/src-tauri/`): `cargo build`
Expected: builds successfully with the new dependency fetched.

- [ ] **Step 2: Implement the process/playback struct**

Append to `synapse/src-tauri/src/tts_pocket.rs`:

```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// Owns the long-lived Python sidecar and the currently-playing audio sink.
/// One instance lives in Tauri's managed state for the app's lifetime.
pub struct TtsSidecar {
    process: Mutex<Option<SidecarProcess>>,
    sink: Mutex<Option<rodio::Sink>>,
    // Kept alive alongside `sink` — dropping the OutputStream stops playback.
    stream: Mutex<Option<rodio::OutputStream>>,
    generation: AtomicU64,
}

impl Default for TtsSidecar {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            sink: Mutex::new(None),
            stream: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

impl TtsSidecar {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure_process(
        &self,
        python_path: &std::path::Path,
        sidecar_path: &std::path::Path,
    ) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|_| "sidecar lock poisoned")?;
        if guard.is_some() {
            return Ok(());
        }
        let mut child = Command::new(python_path)
            .arg(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to start tts sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        *guard = Some(SidecarProcess { child, stdin, stdout: BufReader::new(stdout) });
        Ok(())
    }

    /// Stops any currently-playing audio, bumps the request generation, sends
    /// a new request to the (lazily spawned) sidecar, and plays the result.
    /// A dead sidecar (write/read failure) clears the cached process so the
    /// next call respawns it, and is surfaced as an `Err` for the caller to
    /// fall back to OS-native TTS.
    pub fn speak(
        &self,
        python_path: &std::path::Path,
        sidecar_path: &std::path::Path,
        text: &str,
        voice: &str,
        out_dir: &std::path::Path,
    ) -> Result<(), String> {
        if let Ok(mut sink) = self.sink.lock() {
            if let Some(s) = sink.take() {
                s.stop();
            }
        }

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.ensure_process(python_path, sidecar_path)?;

        let out_path = out_dir.join(format!("tts_{generation}.wav"));
        let request = SidecarRequest {
            id: generation,
            text: text.to_string(),
            voice: voice.to_string(),
            out_path: out_path.to_string_lossy().to_string(),
        };

        let write_and_read = || -> Result<SidecarResponse, String> {
            let mut guard = self.process.lock().map_err(|_| "sidecar lock poisoned")?;
            let proc = guard.as_mut().ok_or("sidecar not running")?;
            writeln!(proc.stdin, "{}", encode_request(&request)).map_err(|e| e.to_string())?;
            let mut line = String::new();
            proc.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if line.is_empty() {
                return Err("sidecar closed its output".to_string());
            }
            decode_response(line.trim())
        };

        let response = match write_and_read() {
            Ok(r) => r,
            Err(e) => {
                // Drop the dead process so the next call respawns it.
                if let Ok(mut guard) = self.process.lock() {
                    *guard = None;
                }
                return Err(e);
            }
        };

        if !is_current(response.id, generation) {
            let _ = std::fs::remove_file(&out_path);
            return Ok(());
        }

        if response.status != "ok" {
            return Err(response.message.unwrap_or_else(|| "tts synthesis failed".to_string()));
        }

        let (stream, handle) = rodio::OutputStream::try_default().map_err(|e| e.to_string())?;
        let sink = rodio::Sink::try_new(&handle).map_err(|e| e.to_string())?;
        let file = std::fs::File::open(&out_path).map_err(|e| e.to_string())?;
        let source = rodio::Decoder::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
        sink.append(source);

        if let Ok(mut s) = self.sink.lock() {
            *s = Some(sink);
        }
        if let Ok(mut st) = self.stream.lock() {
            *st = Some(stream);
        }

        Ok(())
    }
}
```

- [ ] **Step 3: Manual verification (no automated test — requires a live Python env)**

This step is deferred until Task 6 (Python wrapper script) and Task 9 (env download) exist — note it here and re-run it once those land:

1. With the TTS engine downloaded (Task 9), call the new `speak_text` path (Task 7) with a short sentence.
2. Confirm audio plays through the default output device.
3. Trigger a second speak request while the first is still playing; confirm the first cuts off immediately and the second plays.
4. Kill the sidecar process manually (Task Manager) mid-session, then trigger another speak request; confirm it falls back to OS-native TTS and a subsequent request respawns the sidecar successfully.

- [ ] **Step 4: Commit**

```bash
git add synapse/src-tauri/src/tts_pocket.rs synapse/src-tauri/Cargo.toml synapse/src-tauri/Cargo.lock
git commit -m "feat: add pocket-tts sidecar process management and playback"
```

---

### Task 6: Python sidecar wrapper script

**Files:**
- Create: `synapse/src-tauri/resources/tts_sidecar.py`
- Modify: `synapse/src-tauri/tauri.conf.json` (bundle the resource)

Draft below uses `<PYTHON_TTS_CLASS>`/`<PYTHON_TTS_METHOD>` placeholders — **replace these with the real API found in Task 1's notes file** (`docs/superpowers/plans/2026-08-01-pocket-tts-api-notes.md`) before running this task. Do not commit the placeholders as-is.

- [ ] **Step 1: Write the script**

```python
"""Long-lived TTS worker spawned by Synapse. Reads one JSON request per line
from stdin, synthesizes speech with pocket-tts, writes a WAV file to the
requested path, and writes one JSON response per line to stdout. Loads the
model once at startup so repeated requests don't pay model-load cost again.
"""
import json
import sys

from pocket_tts import <PYTHON_TTS_CLASS>

_model = <PYTHON_TTS_CLASS>()


def handle(request: dict) -> dict:
    try:
        text = request["text"]
        voice = request["voice"]
        out_path = request["out_path"]
        _model.<PYTHON_TTS_METHOD>(text=text, voice=voice, output_path=out_path)
        return {"id": request["id"], "status": "ok"}
    except Exception as exc:  # noqa: BLE001 - any failure must produce a response line
        return {"id": request.get("id", 0), "status": "error", "message": str(exc)}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        response = handle(request)
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Bundle it as a Tauri resource**

In `synapse/src-tauri/tauri.conf.json`, add to the `"bundle"` object (after `"icon"`):

```json
"resources": ["resources/tts_sidecar.py"]
```

- [ ] **Step 3: Manual verification**

Once Task 9's Python environment download exists, run the script directly against the extracted embedded Python to confirm it starts, loads the model, and responds to a hand-typed request:

```bash
echo {"id":1,"text":"hello world","voice":"alba","out_path":"C:\\tmp\\test.wav"} | <extracted-python>\python.exe synapse\src-tauri\resources\tts_sidecar.py
```

Expected: one JSON line `{"id": 1, "status": "ok"}` printed, and `C:\tmp\test.wav` exists and plays back correctly.

- [ ] **Step 4: Commit**

```bash
git add synapse/src-tauri/resources/tts_sidecar.py synapse/src-tauri/tauri.conf.json
git commit -m "feat: add pocket-tts sidecar Python script"
```

---

### Task 7: Wire `speak_text` and the `"speak-selected"` wedge in `lib.rs`

**Files:**
- Modify: `synapse/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `inject::copy_selection` (Task 3), `tts_pocket::TtsSidecar` + `TtsSidecar::speak` (Task 5), `tts_setup::is_ready` (Task 9 — stubbed here as `fn is_ready(_: &tauri::AppHandle) -> bool { false }` if Task 9 hasn't landed yet, so this task doesn't block on it; replace the stub once Task 9 exists), `settings::TtsSettings` (Task 2), `show_toast`, `restore_previous_focus`, `hide_overlay` (existing).
- Produces: updated `speak_text` command; new `"speak-selected"` arm in `select_wedge`.

- [ ] **Step 1: Register `TtsSidecar` as managed state**

In `synapse/src-tauri/src/lib.rs`'s `mod` block (top of file), add `mod tts_pocket;` if not already added by Task 4, and `mod tts_setup;` (Task 9 — add now as an empty module stub `pub fn is_ready(_app: &tauri::AppHandle) -> bool { false }` if Task 9 isn't done yet, to keep this task compiling standalone).

In the `tauri::Builder::default()` setup chain (find `.setup(` or `.manage(` calls in `lib.rs`'s `run()` function), add:

```rust
.manage(tts_pocket::TtsSidecar::new())
```

If Task 9 hasn't landed yet, add this temporary stub module directly in `lib.rs` (all four functions `speak_text` below calls, not just `is_ready` — Rust needs every one to exist at compile time even though the `is_ready() == false` branch means the other three are never actually called at runtime):

```rust
mod tts_setup {
    pub fn is_ready(_app: &tauri::AppHandle) -> bool {
        false
    }
    pub fn python_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        Err("tts_setup not implemented yet".to_string())
    }
    pub fn sidecar_script_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        Err("tts_setup not implemented yet".to_string())
    }
    pub fn tts_scratch_dir(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        Err("tts_setup not implemented yet".to_string())
    }
}
```

Task 9 replaces this stub with `mod tts_setup;` pointing at the real `tts_setup.rs` file — delete the inline stub at that point.

- [ ] **Step 2: Update `speak_text` to route through the sidecar**

Replace the existing `speak_text` command (`synapse/src-tauri/src/lib.rs:476-483`):

```rust
/// Speaks text via pocket-tts when its engine is downloaded, falling back to
/// OS-native TTS otherwise (not downloaded yet, or the sidecar just failed).
/// Runs on a background thread so the UI isn't blocked for the duration.
#[tauri::command]
fn speak_text(app: tauri::AppHandle, sidecar: tauri::State<tts_pocket::TtsSidecar>, text: String) {
    let sidecar = sidecar.inner();
    if tts_setup::is_ready(&app) {
        let voice = settings_path(&app)
            .map(|p| settings::load(&p).tts.voice)
            .unwrap_or_else(|_| "alba".to_string());
        if let (Ok(python_path), Ok(sidecar_path), Ok(out_dir)) = (
            tts_setup::python_path(&app),
            tts_setup::sidecar_script_path(&app),
            tts_setup::tts_scratch_dir(&app),
        ) {
            match sidecar.speak(&python_path, &sidecar_path, &text, &voice, &out_dir) {
                Ok(()) => return,
                Err(e) => eprintln!("[synapse] pocket-tts failed, falling back to OS TTS: {e}"),
            }
        }
    }
    std::thread::spawn(move || {
        if let Err(e) = tts::speak(&text) {
            eprintln!("[synapse] TTS failed: {e}");
        }
    });
}
```

- [ ] **Step 3: Add the `"speak-selected"` wedge arm**

In `select_wedge`'s `match wedge.as_str()` block (`synapse/src-tauri/src/lib.rs:128-179`), add a new arm before the catch-all `other =>`:

```rust
"speak-selected" => {
    hide_overlay(&app);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(180));
        #[cfg(target_os = "windows")]
        restore_previous_focus();
        std::thread::sleep(std::time::Duration::from_millis(80));

        match inject::copy_selection(&app) {
            Ok(Some(text)) => {
                let app_for_speak = app.clone();
                let sidecar = app_for_speak.state::<tts_pocket::TtsSidecar>();
                speak_text(app_for_speak.clone(), sidecar, text);
            }
            Ok(None) => show_toast(&app, "No text selected".to_string()),
            Err(e) => {
                eprintln!("[synapse] selection capture failed: {e}");
                show_toast(&app, "Couldn't read selected text".to_string());
            }
        }
    });
}
```

- [ ] **Step 4: Register the new commands in the invoke handler**

In the `.invoke_handler(tauri::generate_handler![...])` list (`synapse/src-tauri/src/lib.rs:536-558`), confirm `speak_text` is still listed (no change needed there — it already is).

- [ ] **Step 5: Build and run existing tests**

Run (from `synapse/src-tauri/`): `cargo build && cargo test --lib`
Expected: builds cleanly, all existing tests still pass (this task adds no new automated tests — it's orchestration wiring covered by Task 4/5's unit tests and Task 5's manual verification).

- [ ] **Step 6: Manual verification**

Trigger the wheel with no text selected anywhere → toast "No text selected". Select text in another app, trigger the wheel, pick "Speak Selected Text" (once Task 8 adds the wedge) → speech plays (OS-native fallback is expected at this point in the plan, since Task 9's env download hasn't landed yet).

- [ ] **Step 7: Commit**

```bash
git add synapse/src-tauri/src/lib.rs
git commit -m "feat: wire speak_text through pocket-tts sidecar with OS-native fallback"
```

---

### Task 8: Add the wheel wedge

**Files:**
- Modify: `synapse/src/wedges.ts`

**Interfaces:**
- Produces: `WedgeId` includes `"speak-selected"`.

- [ ] **Step 1: Add the wedge definition**

In `synapse/src/wedges.ts`, update the `WedgeId` union and `WEDGES` array:

```typescript
export type WedgeId = "stt" | "ai" | "screenshot" | "snippet" | "notepad" | "speak-selected" | "settings";
```

Add before the `"settings"` entry in `WEDGES`:

```typescript
  {
    id: "speak-selected",
    label: "Speak Selected Text",
    icon: "M3 10v4h4l5 5V5L7 10H3Zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12Zm-2.5-8.71v2.06a7 7 0 0 1 0 13.3v2.06a9 9 0 0 0 0-17.42Z",
  },
```

- [ ] **Step 2: Typecheck**

Run (from `synapse/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run `npm run tauri dev`, open the wheel, confirm a 7th slice labeled "Speak Selected Text" renders correctly in the ring (icon visible, no layout overlap — the ring geometry in `wedgePath`/`iconPosition` is computed from wedge count, so this should just work).

- [ ] **Step 4: Commit**

```bash
git add synapse/src/wedges.ts
git commit -m "feat: add Speak Selected Text wedge to the wheel"
```

---

### Task 9: `tts_setup.rs` — download embedded Python, install pocket-tts, pre-warm weights

Uses the real python-build-standalone release URL from Task 1's notes file — replace `<PYTHON_BUILD_STANDALONE_URL>` below with that value before implementing.

**Files:**
- Create: `synapse/src-tauri/src/tts_setup.rs`
- Modify: `synapse/src-tauri/src/lib.rs` (register `mod tts_setup;` for real, replacing the Task 7 stub; add `tts_setup_status`/`download_tts_engine` commands)

**Interfaces:**
- Consumes: `model_download::download_one_file`, `model_download::remote_file_size` (existing, reused as-is).
- Produces: `pub fn is_ready(app: &tauri::AppHandle) -> bool`, `pub fn python_path(app: &tauri::AppHandle) -> Result<PathBuf, String>`, `pub fn sidecar_script_path(app: &tauri::AppHandle) -> Result<PathBuf, String>`, `pub fn tts_scratch_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>`, `pub fn spawn_setup(app: tauri::AppHandle)`, `#[derive(Serialize, Clone)] pub struct SetupProgress { pub stage: String, pub bytes_downloaded: u64, pub bytes_total: u64 }`, events `tts-setup-progress` / `tts-setup-done` / `tts-setup-error`.

- [ ] **Step 1: Write the failing test for readiness detection**

Create `synapse/src-tauri/src/tts_setup.rs`:

```rust
use std::path::{Path, PathBuf};

/// True only once the Python runtime, the installed packages, and the
/// sidecar script are all in place. Checked via a marker file written as the
/// final step of setup, rather than probing pip/torch directly — cheap, and
/// avoids re-deriving "did every stage finish" from partial directory state.
pub fn is_ready_at(dir: &Path) -> bool {
    dir.join("READY").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-tts-setup-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn not_ready_when_marker_absent() {
        let dir = temp_dir("no-marker");
        assert!(!is_ready_at(&dir));
    }

    #[test]
    fn ready_when_marker_present() {
        let dir = temp_dir("with-marker");
        std::fs::write(dir.join("READY"), b"").unwrap();
        assert!(is_ready_at(&dir));
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run (from `synapse/src-tauri/`): `cargo test --lib tts_setup::`
Expected: PASS (2 tests).

- [ ] **Step 3: Implement the full setup pipeline**

Append to `synapse/src-tauri/src/tts_setup.rs`:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

const PYTHON_BUILD_STANDALONE_URL: &str = "<PYTHON_BUILD_STANDALONE_URL>";

static SETTING_UP: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, Clone)]
pub struct SetupProgress {
    pub stage: String, // "python" | "packages" | "weights"
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
}

/// `app_data_dir()/tts-env/` — everything this feature needs lives under one
/// directory so it can be wiped/retried as a unit.
pub fn tts_env_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("tts-env");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn tts_scratch_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = tts_env_dir(app)?.join("scratch");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn python_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(tts_env_dir(app)?.join("python").join("python.exe"))
}

pub fn sidecar_script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources/tts_sidecar.py", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())
}

pub fn is_ready(app: &tauri::AppHandle) -> bool {
    tts_env_dir(app).map(|d| is_ready_at(&d)).unwrap_or(false)
}

/// Spawns the full setup pipeline on a background thread; idempotent while
/// already running, same guard pattern as `model_download::spawn_download`.
pub fn spawn_setup(app: tauri::AppHandle) {
    if SETTING_UP.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let env_dir = tts_env_dir(&app)?;
            let python_dir = env_dir.join("python");
            std::fs::create_dir_all(&python_dir).map_err(|e| e.to_string())?;

            // Stage 1: Python runtime.
            let client = reqwest::blocking::Client::new();
            let archive_name = "python-runtime.tar.gz";
            let base_url = PYTHON_BUILD_STANDALONE_URL
                .rsplit_once('/')
                .map(|(base, _)| base)
                .ok_or("malformed python build standalone URL")?;
            let file_name = PYTHON_BUILD_STANDALONE_URL
                .rsplit_once('/')
                .map(|(_, name)| name)
                .ok_or("malformed python build standalone URL")?;
            let total = crate::model_download::remote_file_size(&client, base_url, file_name)?;
            crate::model_download::download_one_file(
                &client,
                base_url,
                &env_dir,
                file_name,
                |downloaded, _| {
                    let _ = app.emit(
                        "tts-setup-progress",
                        SetupProgress { stage: "python".to_string(), bytes_downloaded: downloaded, bytes_total: total },
                    );
                },
            )?;
            extract_python_archive(&env_dir.join(file_name), &python_dir)?;
            let _ = archive_name; // archive_name reserved for a future non-tar.gz platform variant

            // Stage 2: pip install torch (CPU) + pocket-tts.
            let pip = python_dir.join("Scripts").join("pip.exe");
            let _ = app.emit(
                "tts-setup-progress",
                SetupProgress { stage: "packages".to_string(), bytes_downloaded: 0, bytes_total: 0 },
            );
            run_pip_install(&pip, &["torch", "--index-url", "https://download.pytorch.org/whl/cpu"])?;
            run_pip_install(&pip, &["pocket-tts"])?;

            // Stage 3: pre-warm model weights with a throwaway request so the
            // first real "speak" doesn't pay the Hugging Face download cost.
            let _ = app.emit(
                "tts-setup-progress",
                SetupProgress { stage: "weights".to_string(), bytes_downloaded: 0, bytes_total: 0 },
            );
            let scratch = tts_scratch_dir(&app)?;
            prewarm_weights(&python_dir.join("python.exe"), &sidecar_script_path(&app)?, &scratch)?;

            std::fs::write(env_dir.join("READY"), b"").map_err(|e| e.to_string())?;
            Ok(())
        })();

        SETTING_UP.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                let _ = app.emit("tts-setup-done", ());
            }
            Err(e) => {
                eprintln!("[synapse] tts setup failed: {e}");
                let _ = app.emit("tts-setup-error", e);
            }
        }
    });
}

fn extract_python_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    // python-build-standalone `install_only` archives already contain the
    // installed layout at the archive root, so this is a plain extract.
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(dest).map_err(|e| e.to_string())
}

fn run_pip_install(pip: &Path, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(pip)
        .arg("install")
        .args(args)
        .status()
        .map_err(|e| format!("failed to run pip: {e}"))?;
    if !status.success() {
        return Err(format!("pip install {args:?} exited with {status}"));
    }
    Ok(())
}

fn prewarm_weights(python: &Path, sidecar_script: &Path, scratch_dir: &Path) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new(python)
        .arg(sidecar_script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out_path = scratch_dir.join("prewarm.wav");
    let request = crate::tts_pocket::SidecarRequest {
        id: 0,
        text: "warming up".to_string(),
        voice: "alba".to_string(),
        out_path: out_path.to_string_lossy().to_string(),
    };
    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, "{}", crate::tts_pocket::encode_request(&request)).map_err(|e| e.to_string())?;
    }
    child.wait().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out_path);
    Ok(())
}
```

Add to `synapse/src-tauri/Cargo.toml`'s `[dependencies]`:

```toml
flate2 = "1"
tar = "0.4"
```

- [ ] **Step 4: Replace the Task 7 stub and register new commands**

In `synapse/src-tauri/src/lib.rs`, remove the temporary `mod tts_setup { ... }` stub added in Task 7 and add `mod tts_setup;` to the top-level `mod` list instead.

Add new commands near `model_status`/`download_model`:

```rust
#[tauri::command]
fn tts_setup_status(app: tauri::AppHandle) -> bool {
    tts_setup::is_ready(&app)
}

#[tauri::command]
fn download_tts_engine(app: tauri::AppHandle) {
    tts_setup::spawn_setup(app);
}
```

Add both to the `tauri::generate_handler![...]` list.

- [ ] **Step 5: Build and run tests**

Run (from `synapse/src-tauri/`): `cargo build && cargo test --lib`
Expected: builds cleanly, all tests pass including the two new `tts_setup::` tests.

- [ ] **Step 6: Manual verification**

Trigger `download_tts_engine` (via a temporary direct `invoke` call from devtools, since Settings UI isn't wired until Task 11) and confirm: the python runtime downloads and extracts, `pip install` succeeds for both packages, the prewarm step produces no errors, and `tts_setup_status` returns `true` afterward. Then re-run Task 5's manual verification steps end-to-end with the real engine.

- [ ] **Step 7: Commit**

```bash
git add synapse/src-tauri/src/tts_setup.rs synapse/src-tauri/src/lib.rs synapse/src-tauri/Cargo.toml synapse/src-tauri/Cargo.lock
git commit -m "feat: add pocket-tts environment setup (python runtime + packages + weight prewarm)"
```

---

### Task 10: Frontend `useTtsSetup()` hook

**Files:**
- Create: `synapse/src/ttsSetup.ts`

**Interfaces:**
- Consumes: Tauri commands `tts_setup_status`, `download_tts_engine` (Task 9); events `tts-setup-progress`, `tts-setup-done`, `tts-setup-error` (Task 9).
- Produces: `useTtsSetup()` returning `{ ready, downloading, stage, error, start }`.

- [ ] **Step 1: Implement the hook**

```typescript
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TtsSetupProgress {
  stage: "python" | "packages" | "weights";
  bytes_downloaded: number;
  bytes_total: number;
}

const STAGE_LABELS: Record<TtsSetupProgress["stage"], string> = {
  python: "Downloading Python runtime…",
  packages: "Installing packages…",
  weights: "Downloading voice model…",
};

/**
 * State machine for the pocket-tts engine setup, mirroring
 * `useModelDownload()`'s shape but stage-aware: unlike the flat ASR file
 * list, setup here has qualitatively different stages (runtime download,
 * pip install, weight prewarm) so a single blended byte counter would be
 * misleading — this exposes a stage label instead of a byte total.
 */
export function useTtsSetup() {
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [stage, setStage] = useState<TtsSetupProgress["stage"] | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    invoke<boolean>("tts_setup_status")
      .then(setReady)
      .catch((e) => console.error("[synapse] tts_setup_status failed:", e));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const unlistenProgress = listen<TtsSetupProgress>("tts-setup-progress", (e) => {
      setStage(e.payload.stage);
    });
    const unlistenDone = listen("tts-setup-done", () => {
      setDownloading(false);
      setReady(true);
      setStage(null);
    });
    const unlistenError = listen<string>("tts-setup-error", (e) => {
      setDownloading(false);
      setError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  const start = useCallback(() => {
    setError("");
    setStage(null);
    setDownloading(true);
    invoke("download_tts_engine").catch((e) => {
      setDownloading(false);
      setError(String(e));
    });
  }, []);

  return {
    ready,
    downloading,
    stage,
    stageLabel: stage ? STAGE_LABELS[stage] : "",
    error,
    start,
    refresh,
  };
}
```

- [ ] **Step 2: Typecheck**

Run (from `synapse/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add synapse/src/ttsSetup.ts
git commit -m "feat: add useTtsSetup frontend hook"
```

---

### Task 11: Settings → Voice UI (TTS engine row + voice picker)

**Files:**
- Modify: `synapse/src/settings/VoiceSection.tsx`
- Modify: `synapse/src/models.ts`

**Interfaces:**
- Consumes: `useTtsSetup()` (Task 10), `formatBytes` (existing, from `modelDownload.ts`).
- Produces: updated `Settings` type with `tts: TtsSettings`.

- [ ] **Step 1: Extend `models.ts`**

In `synapse/src/models.ts`, add:

```typescript
export interface TtsSettings {
  voice: string;
}

export const TTS_VOICES = [
  "alba", "giovanni", "lola", "amelie", "hans", "sofia", "marco", "elena",
  "julien", "greta", "paolo", "mira", "felix", "carmen", "otto", "nadia",
  "leon", "isla", "tomas", "vera", "diego", "lena", "rico", "anja", "theo",
] as const;
```

And add `tts: TtsSettings;` to the `Settings` interface.

- [ ] **Step 2: Update `VoiceSection.tsx`**

```tsx
import { formatBytes, useModelDownload } from "../modelDownload";
import { useTtsSetup } from "../ttsSetup";
import { TTS_VOICES, type Settings } from "../models";

interface VoiceSectionProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

export default function VoiceSection({ settings, onChange }: VoiceSectionProps) {
  const model = useModelDownload();
  const tts = useTtsSetup();

  return (
    <div className="set-section">
      <h2 className="set-title">Voice</h2>

      <div className="set-row">
        <span className="set-label">Model</span>
        <div className="set-key">
          <span className={`set-badge ${model.ready ? "set-ok" : "set-missing"}`}>
            {model.ready ? "Downloaded" : "Not downloaded"}
          </span>
          {!model.downloading && (
            <button className="set-btn" onClick={model.start}>
              {model.ready ? "Re-download" : "Download (~630 MB)"}
            </button>
          )}
        </div>
      </div>

      {model.downloading && (
        <div className="set-progress">
          <div className={`set-meter ${model.known ? "" : "set-meter-idle"}`}>
            <div
              className="set-meter-fill"
              style={model.known ? { width: `${model.percent}%` } : undefined}
            />
          </div>
          <div className="set-progress-foot">
            <span>
              {model.known ? `${Math.floor(model.percent)}% · ` : ""}
              {formatBytes(model.downloaded)}
              {model.known ? ` of ${formatBytes(model.total)}` : ""}
            </span>
            <span>{model.remaining}</span>
          </div>
        </div>
      )}
      {model.error && <div className="set-error">{model.error}</div>}

      <p className="set-hint">
        Speech-to-Text runs fully offline using this local model, required for dictation.
      </p>

      <div className="set-row">
        <span className="set-label">Text-to-Speech engine</span>
        <div className="set-key">
          <span className={`set-badge ${tts.ready ? "set-ok" : "set-missing"}`}>
            {tts.ready ? "Downloaded" : "Not downloaded"}
          </span>
          {!tts.downloading && (
            <button className="set-btn" onClick={tts.start}>
              {tts.ready ? "Re-download" : "Download (~1-2 GB)"}
            </button>
          )}
        </div>
      </div>

      {tts.downloading && (
        <div className="set-progress">
          <div className="set-meter set-meter-idle" />
          <div className="set-progress-foot">
            <span>{tts.stageLabel || "Starting…"}</span>
          </div>
        </div>
      )}
      {tts.error && <div className="set-error">{tts.error}</div>}

      <div className="set-row">
        <span className="set-label">Voice</span>
        <select
          className="set-select"
          disabled={!tts.ready}
          value={settings.tts.voice}
          onChange={(e) => onChange({ ...settings, tts: { ...settings.tts, voice: e.target.value } })}
        >
          {TTS_VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <p className="set-hint">
        "Speak Selected Text" and reading AI responses aloud both use this voice once downloaded,
        falling back to your OS's built-in voice otherwise.
      </p>
    </div>
  );
}
```

Note: this introduces `settings`/`onChange` props onto `VoiceSection` where none existed before — update its call site in the parent Settings component (find it via `grep -rn "VoiceSection" synapse/src`) to pass the same `settings`/`onChange` pattern already used by sibling sections there (follow that file's existing prop-drilling convention rather than introducing a new one).

- [ ] **Step 3: Typecheck**

Run (from `synapse/`): `npx tsc --noEmit`
Expected: no errors. Fix the `VoiceSection` call site if the typecheck flags a missing-props error.

- [ ] **Step 4: Manual verification**

Run `npm run tauri dev`, open Settings → Voice, confirm: the new TTS engine row renders, clicking Download starts the setup flow and the stage label updates as it progresses, the voice dropdown is disabled until `ready` and enabled afterward, and selecting a voice persists (reopen Settings, confirm the selection stuck).

- [ ] **Step 5: Commit**

```bash
git add synapse/src/settings/VoiceSection.tsx synapse/src/models.ts
git commit -m "feat: add TTS engine download and voice picker to Settings"
```

---

### Task 12: Onboarding step

**Files:**
- Modify: `synapse/src/Onboarding.tsx`

- [ ] **Step 1: Add the step**

In `synapse/src/Onboarding.tsx`, update:

```typescript
const STEPS = ["welcome", "mic", "model", "voice-engine", "done"] as const;
```

```typescript
const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  mic: "Microphone",
  model: "Model",
  "voice-engine": "Voice",
  done: "Finish",
};
```

Add `import { useTtsSetup } from "./ttsSetup";` and `const tts = useTtsSetup();` alongside the existing `const model = useModelDownload();`.

Add a new step block after the `"model"` block:

```tsx
{step === "voice-engine" && (
  <div className="ob-step">
    <h1 className="ob-title">Speak Selected Text (optional)</h1>
    <p className="ob-text">
      Select text anywhere and have Synapse read it aloud. This downloads a self-contained
      speech engine, roughly 1-2 GB — optional, and you can grab it later from Settings → Voice
      instead.
    </p>

    <div className={`ob-card ${tts.ready ? "ob-card-ok" : ""}`}>
      {tts.ready ? (
        <>
          <div className="ob-card-row">
            <span className="ob-pill ob-pill-ok">Installed</span>
          </div>
          <p className="ob-card-note">The voice engine is ready to use.</p>
        </>
      ) : tts.downloading ? (
        <>
          <div className="ob-meter-head">
            <span className="ob-meter-pct">{tts.stageLabel || "Starting…"}</span>
          </div>
          <div className="ob-meter ob-meter-idle" />
        </>
      ) : (
        <>
          <div className="ob-card-row">
            <span className="ob-pill">Not downloaded</span>
            <button className="ob-btn ob-btn-sm" onClick={tts.start}>
              {tts.error ? "Try again" : "Download now"}
            </button>
          </div>
          <p className="ob-card-note">
            {tts.error || "You can skip this and grab it later from Settings → Voice."}
          </p>
        </>
      )}
    </div>
  </div>
)}
```

Update the footer's "Continue"/"Skip for now" label logic to also cover the new step:

```typescript
{step === "welcome"
  ? "Get started"
  : (step === "model" && !model.ready && !model.downloading) ||
      (step === "voice-engine" && !tts.ready && !tts.downloading)
    ? "Skip for now"
    : "Continue"}
```

- [ ] **Step 2: Typecheck**

Run (from `synapse/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Trigger onboarding (or run it standalone per this repo's existing manual-testing convention for onboarding), step through to the new "Voice" step, confirm: the step dot appears in the header progress indicator, "Skip for now" is offered when not downloaded, and clicking "Download now" starts the setup flow with stage labels updating live.

- [ ] **Step 4: Commit**

```bash
git add synapse/src/Onboarding.tsx
git commit -m "feat: add optional voice engine download step to onboarding"
```

---

### Task 13: End-to-end verification

No new files — this task is a final pass confirming the whole feature works together, per the design doc's testing section.

- [ ] **Step 1: Full test suite**

Run (from `synapse/src-tauri/`): `cargo test --lib`
Expected: all tests pass (settings, inject, tts_pocket, tts_setup, plus pre-existing suites).

Run (from `synapse/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Manual end-to-end pass**

With a clean app-data directory (or `Re-download` on both rows in Settings → Voice):
1. Download the TTS engine from Settings → Voice; confirm all three stages complete and the row shows "Downloaded".
2. Pick a non-default voice from the dropdown.
3. Select text in another application (e.g. a browser or Notepad), open the wheel, choose "Speak Selected Text"; confirm it speaks in the chosen voice.
4. While it's speaking, trigger it again on a different selection; confirm the first utterance cuts off and the second plays.
5. Open the AI panel, send a prompt, use its existing "read aloud" control; confirm it now also uses the pocket-tts voice (not the OS voice) since the engine is downloaded.
6. Delete/rename `app_data_dir()/tts-env/READY` to simulate an undownloaded engine, restart the app, repeat step 3; confirm it falls back to OS-native TTS with no error surfaced to the user.
7. Trigger the wheel action with nothing selected; confirm the "No text selected" toast appears and nothing plays.

- [ ] **Step 3: Update `PROGRESS.md`**

Per this repo's convention (`PROGRESS.md` is the session-by-session source of truth), add an entry summarizing what was built, what's verified, and any known gaps (e.g. macOS paths in `tts_setup.rs` are untested, exact python-build-standalone URL may need periodic bumping).

```bash
git add PROGRESS.md
git commit -m "docs: record Speak Selected Text feature in progress log"
```
