# Onboarding Wizard + Model Download + MSI Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Synapse's ship-blocker — ship a first-run onboarding wizard, a resumable
first-run model download, and a Windows `.msi` installer, so anyone can install and run Synapse
without a dev machine's manually-placed model files.

**Architecture:** A new decorated `onboarding` Tauri window (destroyed, not hidden, on close)
shown automatically when `settings.json`'s new `onboarding_complete` flag is `false`. It walks
Welcome → Microphone → Model download → Done. The ~690MB Parakeet model streams from
HuggingFace via a new `model_download` Rust module (resumable via HTTP Range requests, written to
a `.part` file, renamed on success), replacing `asr.rs`'s hardcoded relative `model/` path with
the resolved app-data directory. Download progress is broadcast via Tauri events, mirroring the
existing `ai-delta`/`ai-done`/`ai-error` pattern. A minimal Settings → Voice section is the
"download later" entry point for anyone who skips it. Packaging switches
`tauri.conf.json`'s bundle target to `msi` (Tauri's built-in WiX bundler).

**Tech Stack:** Rust (Tauri v2, `reqwest` blocking client, `cpal`), React/TypeScript frontend,
`mockito` for HTTP-mock unit tests.

## Global Constraints

- Windows-only for this plan — no macOS-specific onboarding/permissions/packaging (no Mac
  available to test on; PROGRESS.md defers this explicitly).
- API keys never touch `settings.json` (unrelated to this plan, but `settings.rs` is touched —
  don't regress this).
- `settings.rs`'s `load`/`save` must keep working with missing/unknown fields (forward/backward
  compat) — every new field needs `#[serde(default)]`.
- Model files: `config.json`, `decoder_joint-model.onnx`, `encoder-model.onnx`, `vocab.txt`, from
  `https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/<file>` (exact names
  and source already used in README.md — don't diverge).
- Follow existing patterns: hand-rolled JSON settings store (not `tauri-plugin-store`), Tauri
  events for async progress (not polling), `#[cfg(debug_assertions)]` `open_devtools()` on every
  new window, hide-vs-destroy conventions as documented per window.
- Dark theme / blue-accent visual language from `Settings.css` (`#1a1a1c` bg, `#eaeaea` text,
  `#5aaaff`-family accent) — new CSS must match, not introduce a new palette.

---

## Task 1: `onboarding_complete` settings field

**Files:**
- Modify: `synapse/src-tauri/src/settings.rs`

**Interfaces:**
- Produces: `Settings.onboarding_complete: bool` (serde field, `#[serde(default)]`, defaults
  `false`). Consumed by Task 5 (window auto-show logic) and Task 6 (frontend `finish()` call).

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `settings.rs`:

```rust
#[test]
fn onboarding_complete_defaults_false_and_persists_true() {
    let path = temp_dir("onboarding").join("settings.json");

    let mut settings = load(&path);
    assert!(!settings.onboarding_complete, "defaults false for a fresh install");

    settings.onboarding_complete = true;
    save(&path, &settings).expect("save settings");

    let reloaded = load(&path);
    assert!(reloaded.onboarding_complete, "persists across a reload");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib onboarding_complete -- --nocapture` (from `synapse/src-tauri`)
Expected: FAIL — `no field \`onboarding_complete\` on type \`Settings\``

- [ ] **Step 3: Add the field**

In `settings.rs`, add the field to `Settings`:

```rust
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub onboarding_complete: bool,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib -- --nocapture` (from `synapse/src-tauri`)
Expected: PASS — all settings.rs tests (5 total now) pass, including
`round_trips_with_missing_and_unknown_fields` (still passes unchanged: `bool::default()` is
`false`, matching that test's implicit expectations).

- [ ] **Step 5: Commit**

```bash
git add synapse/src-tauri/src/settings.rs
git commit -m "feat: add onboarding_complete field to settings"
```

---

## Task 2: Model download core logic (pure, testable)

**Files:**
- Create: `synapse/src-tauri/src/model_download.rs`
- Modify: `synapse/src-tauri/src/lib.rs:1-8` (add `mod model_download;`)
- Modify: `synapse/src-tauri/Cargo.toml` (add `mockito` dev-dependency)

**Interfaces:**
- Produces: `pub const MODEL_FILES: [&str; 4]`, `pub fn is_downloaded(dir: &Path) -> bool`,
  `pub fn download_one_file(client: &reqwest::blocking::Client, base_url: &str, dir: &Path, file: &str, on_progress: impl FnMut(u64, u64)) -> Result<(), String>`
  — consumed by Task 3 (Tauri orchestration) and Task 3's `asr.rs` change (`is_downloaded`).

- [ ] **Step 1: Add the mockito dev-dependency**

In `synapse/src-tauri/Cargo.toml`, add a new section (there is no existing
`[dev-dependencies]` section — add it after `[dependencies]`, before the `[target...]` sections):

```toml
[dev-dependencies]
mockito = "1"
```

- [ ] **Step 2: Write the failing tests**

Create `synapse/src-tauri/src/model_download.rs` with just the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-model-download-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn downloads_file_and_renames_part_to_final() {
        let mut server = mockito::Server::new();
        let body = b"hello world, this is fake model data";
        let _m = server
            .mock("GET", "/config.json")
            .with_status(200)
            .with_body(body.as_slice())
            .create();

        let dir = temp_dir("basic");
        let client = reqwest::blocking::Client::new();
        let mut progress_calls = Vec::new();
        download_one_file(&client, &server.url(), &dir, "config.json", |d, t| {
            progress_calls.push((d, t))
        })
        .expect("download succeeds");

        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), body);
        assert!(!dir.join("config.json.part").exists(), "part file is renamed away");
        assert!(!progress_calls.is_empty(), "progress callback fired at least once");
    }

    #[test]
    fn skips_download_when_final_file_already_exists() {
        let mut server = mockito::Server::new();
        // No mock registered for GET — if the function makes a request at
        // all, `.create()` never having been called means mockito's server
        // returns a generic 501, which download_one_file would surface as
        // an error, failing this test.
        let dir = temp_dir("already-done");
        std::fs::write(dir.join("vocab.txt"), b"already here").unwrap();

        let client = reqwest::blocking::Client::new();
        download_one_file(&client, &server.url(), &dir, "vocab.txt", |_, _| {})
            .expect("no-op succeeds without a network request");

        assert_eq!(std::fs::read(dir.join("vocab.txt")).unwrap(), b"already here");
    }

    #[test]
    fn resumes_from_existing_part_file_using_range_request() {
        let mut server = mockito::Server::new();
        let full = b"0123456789ABCDEF";
        let existing_prefix = &full[..6];
        let remainder = &full[6..];

        let dir = temp_dir("resume");
        std::fs::write(dir.join("vocab.txt.part"), existing_prefix).unwrap();

        let _m = server
            .mock("GET", "/vocab.txt")
            .match_header("range", "bytes=6-")
            .with_status(206)
            .with_body(remainder)
            .create();

        let client = reqwest::blocking::Client::new();
        download_one_file(&client, &server.url(), &dir, "vocab.txt", |_, _| {})
            .expect("resumed download succeeds");

        assert_eq!(std::fs::read(dir.join("vocab.txt")).unwrap(), full);
    }

    #[test]
    fn truncated_download_is_rejected_and_part_file_is_kept() {
        let mut server = mockito::Server::new();
        // Server claims a Content-Length larger than what it actually sends,
        // simulating a connection dropped mid-transfer.
        let _m = server
            .mock("GET", "/encoder-model.onnx")
            .with_status(200)
            .with_header("content-length", "100")
            .with_body("short")
            .create();

        let dir = temp_dir("truncated");
        let client = reqwest::blocking::Client::new();
        let result = download_one_file(&client, &server.url(), &dir, "encoder-model.onnx", |_, _| {});

        assert!(result.is_err(), "truncated transfer is rejected, not silently accepted");
        assert!(
            !dir.join("encoder-model.onnx").exists(),
            "incomplete download is never promoted to the final filename"
        );
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --lib model_download -- --nocapture` (from `synapse/src-tauri`)
Expected: FAIL to compile — `download_one_file`/`is_downloaded`/`MODEL_FILES` don't exist yet.

- [ ] **Step 4: Implement the module**

Add above the test module in `model_download.rs`:

```rust
use std::io::{Read, Write};
use std::path::Path;

pub const MODEL_FILES: [&str; 4] = [
    "config.json",
    "decoder_joint-model.onnx",
    "encoder-model.onnx",
    "vocab.txt",
];

pub const MODEL_REPO_BASE: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main";

/// True only when every required model file is present. A partial `.part`
/// file left over from an interrupted download does not count.
pub fn is_downloaded(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|f| dir.join(f).is_file())
}

/// Downloads one file into `dir/<file>`, resuming from `dir/<file>.part` if
/// present. A no-op if `dir/<file>` already exists. `on_progress(bytes_downloaded,
/// bytes_total)` fires after every chunk read. `base_url` is injectable so
/// tests can point at a local mock server instead of huggingface.co.
pub fn download_one_file(
    client: &reqwest::blocking::Client,
    base_url: &str,
    dir: &Path,
    file: &str,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let final_path = dir.join(file);
    if final_path.is_file() {
        return Ok(());
    }

    let part_path = dir.join(format!("{file}.part"));
    let existing = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    let url = format!("{base_url}/{file}");

    let mut request = client.get(&url);
    if existing > 0 {
        request = request.header("Range", format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .map_err(|e| format!("{file}: request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{file}: server returned {}", response.status()));
    }
    let resumed = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

    let remaining = response
        .content_length()
        .ok_or_else(|| format!("{file}: server did not report a size"))?;
    let total = if resumed { existing + remaining } else { remaining };

    let mut out = if resumed {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&part_path)
            .map_err(|e| e.to_string())?
    } else {
        std::fs::File::create(&part_path).map_err(|e| e.to_string())?
    };
    let mut downloaded = if resumed { existing } else { 0 };

    let mut reader = response;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("{file}: read failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        on_progress(downloaded, total);
    }

    if downloaded != total {
        return Err(format!(
            "{file}: got {downloaded} bytes, expected {total} — connection likely dropped"
        ));
    }

    drop(out);
    std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --lib model_download -- --nocapture` (from `synapse/src-tauri`)
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Register the module and confirm the whole crate still builds**

In `synapse/src-tauri/src/lib.rs`, add to the `mod` list at the top:

```rust
mod model_download;
```

Run: `cargo build` (from `synapse/src-tauri`)
Expected: builds clean (the module isn't used anywhere yet, so expect an `unused` warning at
most, not an error — if any function shows a dead-code warning, prefix it with `#[allow(dead_code)]`
temporarily; Task 3 wires it in and the warning disappears).

- [ ] **Step 7: Commit**

```bash
git add synapse/src-tauri/src/model_download.rs synapse/src-tauri/src/lib.rs synapse/src-tauri/Cargo.toml synapse/src-tauri/Cargo.lock
git commit -m "feat: add resumable model file download core logic"
```

---

## Task 3: Wire model download into Tauri (commands, events, ASR path fix)

**Files:**
- Modify: `synapse/src-tauri/src/model_download.rs` (add Tauri-facing orchestration)
- Modify: `synapse/src-tauri/src/asr.rs:28-42` (`preload_model` takes a resolved path)
- Modify: `synapse/src-tauri/src/lib.rs` (new commands, setup wiring)

**Interfaces:**
- Consumes: `model_download::is_downloaded`, `model_download::download_one_file`,
  `model_download::MODEL_FILES`, `model_download::MODEL_REPO_BASE` (Task 2).
- Produces: `model_download::model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>`,
  `model_download::spawn_download(app: tauri::AppHandle, on_success: impl FnOnce() + Send + 'static)`,
  Tauri commands `model_status() -> Result<bool, String>` and `download_model()`, events
  `model-download-progress` (payload `{ file, file_bytes_downloaded, file_bytes_total,
  overall_bytes_downloaded, overall_bytes_total }`), `model-download-done`,
  `model-download-error` (payload: `String` message). `asr::preload_model(model_dir: PathBuf)`
  (signature change — was `preload_model()`). Consumed by Task 5 (`lib.rs` setup) and Task 6/7
  (frontend `invoke`/`listen` calls).

- [ ] **Step 1: Add the Tauri-facing orchestration to `model_download.rs`**

Append to `synapse/src-tauri/src/model_download.rs`, above the `#[cfg(test)]` module:

```rust
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, Clone)]
pub struct DownloadProgress {
    pub file: String,
    pub file_bytes_downloaded: u64,
    pub file_bytes_total: u64,
    pub overall_bytes_downloaded: u64,
    pub overall_bytes_total: u64,
}

/// `app_data_dir()/model/` — replaces asr.rs's old hardcoded relative "model"
/// path so the app works from an installed location, not just a dev checkout.
pub fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("model");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Spawns the 4-file download on a background thread; idempotent while a
/// download is already in flight (a second call is a no-op, not a second
/// concurrent download). Progress/success/failure are reported via Tauri
/// events rather than a return value, since the work happens off-thread.
/// `on_success` lets the caller react to completion (lib.rs uses it to
/// reload the ASR model) without this module depending on asr.rs — same
/// "stay a pure module" precedent as ai.rs's `stream_chat` taking a
/// caller-resolved model string instead of reading settings itself.
pub fn spawn_download(app: tauri::AppHandle, on_success: impl FnOnce() + Send + 'static) {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let dir = model_dir(&app)?;
            let client = reqwest::blocking::Client::new();

            // One HEAD request per not-yet-downloaded file, purely so the UI
            // can show an accurate overall byte total from the first
            // progress event instead of only learning sizes as each file
            // starts (the two biggest files are ~10x the two smallest, so a
            // naive equal-weight-per-file progress bar would be misleading).
            let mut file_totals: Vec<u64> = Vec::with_capacity(MODEL_FILES.len());
            for file in MODEL_FILES {
                if let Ok(meta) = std::fs::metadata(dir.join(file)) {
                    file_totals.push(meta.len());
                    continue;
                }
                let url = format!("{MODEL_REPO_BASE}/{file}");
                let resp = client
                    .head(&url)
                    .send()
                    .map_err(|e| format!("{file}: HEAD failed: {e}"))?;
                let total = resp
                    .content_length()
                    .ok_or_else(|| format!("{file}: server did not report a size"))?;
                file_totals.push(total);
            }
            let overall_total: u64 = file_totals.iter().sum();

            let mut overall_base: u64 = 0;
            for (i, file) in MODEL_FILES.iter().enumerate() {
                let app_for_progress = app.clone();
                let base = overall_base;
                let file_name = file.to_string();
                download_one_file(&client, MODEL_REPO_BASE, &dir, file, move |file_downloaded, file_total| {
                    let _ = app_for_progress.emit(
                        "model-download-progress",
                        DownloadProgress {
                            file: file_name.clone(),
                            file_bytes_downloaded: file_downloaded,
                            file_bytes_total: file_total,
                            overall_bytes_downloaded: base + file_downloaded,
                            overall_bytes_total: overall_total,
                        },
                    );
                })?;
                overall_base += file_totals[i];
            }
            Ok(())
        })();

        DOWNLOADING.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                on_success();
                let _ = app.emit("model-download-done", ());
            }
            Err(e) => {
                eprintln!("[synapse] model download failed: {e}");
                let _ = app.emit("model-download-error", e);
            }
        }
    });
}
```

- [ ] **Step 2: Update `asr.rs` to load from the resolved model directory**

In `synapse/src-tauri/src/asr.rs`, replace the `preload_model` function (currently lines 28-42):

```rust
/// Loading the model takes ~1.2s (measured in spikes/asr-spike) — done once
/// on a background thread at app startup so the first dictation isn't slow.
/// A no-op (not an error) if the model hasn't been downloaded yet — dictation
/// is simply unavailable until Settings > Voice (or onboarding) downloads it.
pub fn preload_model(model_dir: std::path::PathBuf) {
    std::thread::spawn(move || {
        if !crate::model_download::is_downloaded(&model_dir) {
            println!("[synapse] ASR model not downloaded yet — dictation unavailable until it is");
            return;
        }
        match ParakeetTDT::from_pretrained(model_dir.to_string_lossy().as_ref(), None) {
            Ok(model) => {
                let _ = MODEL.set(Mutex::new(model));
                println!("[synapse] ASR model loaded");
            }
            Err(e) => eprintln!("[synapse] failed to load ASR model: {e}"),
        }
    });
}
```

- [ ] **Step 3: Add the two new commands and register them in `lib.rs`**

Add near the other settings-adjacent commands in `synapse/src-tauri/src/lib.rs` (e.g. after
`delete_api_key`):

```rust
#[tauri::command]
fn model_status(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(model_download::is_downloaded(&model_download::model_dir(&app)?))
}

/// Reloading the ASR model after a successful download means dictation works
/// immediately without an app restart, even if the user downloaded from
/// Settings > Voice rather than during onboarding.
#[tauri::command]
fn download_model(app: tauri::AppHandle) -> Result<(), String> {
    let dir = model_download::model_dir(&app)?;
    model_download::spawn_download(app, move || asr::preload_model(dir));
    Ok(())
}
```

Add `model_status,` and `download_model,` to the `tauri::generate_handler![...]` list.

Update the `.setup()` closure's existing `asr::preload_model();` call (currently the first line of
`.setup(|app| { ... })`) to:

```rust
asr::preload_model(model_download::model_dir(app.handle())?);
```

- [ ] **Step 4: Run the full test suite and build**

Run: `cargo test --lib` (from `synapse/src-tauri`)
Expected: PASS — 10 tests total (settings.rs ×5 including Task 1's new test, ai.rs ×1,
model_download.rs ×4), no failures.

Run: `cargo build` (from `synapse/src-tauri`)
Expected: clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add synapse/src-tauri/src/model_download.rs synapse/src-tauri/src/asr.rs synapse/src-tauri/src/lib.rs
git commit -m "feat: wire model download into Tauri commands, fix ASR hardcoded model path"
```

---

## Task 4: Microphone access check

**Files:**
- Modify: `synapse/src-tauri/src/asr.rs` (add `check_mic_access`)
- Modify: `synapse/src-tauri/src/lib.rs` (new command)

**Interfaces:**
- Produces: `asr::check_mic_access() -> Result<(), String>`, Tauri command
  `check_mic_access() -> Result<(), String>`. Consumed by Task 6 (onboarding mic step).

- [ ] **Step 1: Add `check_mic_access` to `asr.rs`**

Add near `record_and_transcribe` in `synapse/src-tauri/src/asr.rs` (reuses the same
`build_stream` helper `record_and_transcribe` already uses, so this exercises the identical
device-open path that real dictation does):

```rust
/// Briefly opens (and immediately drops) an input stream to confirm Windows
/// currently allows this app microphone access. Used only by onboarding —
/// normal dictation doesn't pre-check, it just tries to record and reports
/// failure inline if that happens.
pub fn check_mic_access() -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no microphone found — check that an input device is connected and enabled")?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("could not read microphone config: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
    let done = Arc::new(AtomicBool::new(false));
    let state = Arc::new(Mutex::new(SilenceState {
        heard_speech: false,
        silence_since: None,
    }));

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::I32 => build_stream::<i32>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::I8 => build_stream::<i8>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::U8 => build_stream::<u8>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        other => Err(format!("unsupported microphone sample format: {other:?}")),
    }?;

    stream.play().map_err(|e| format!("microphone access blocked: {e}"))?;
    drop(stream);
    Ok(())
}
```

- [ ] **Step 2: Add the command in `lib.rs`**

```rust
#[tauri::command]
fn check_mic_access() -> Result<(), String> {
    asr::check_mic_access()
}
```

Add `check_mic_access,` to `tauri::generate_handler![...]`.

- [ ] **Step 3: Build and manually verify**

Run: `cargo build` (from `synapse/src-tauri`)
Expected: clean build.

Manual check (deferred to Task 6's end-to-end pass, since there's no UI to trigger this command
yet): note it here as a dependency for that later verification.

- [ ] **Step 4: Commit**

```bash
git add synapse/src-tauri/src/asr.rs synapse/src-tauri/src/lib.rs
git commit -m "feat: add microphone access check for onboarding"
```

---

## Task 5: Onboarding window lifecycle + capabilities

**Files:**
- Modify: `synapse/src-tauri/src/lib.rs` (new `ONBOARDING_LABEL`, window creation in `.setup()`)
- Modify: `synapse/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `settings::Settings.onboarding_complete` (Task 1), `settings_path` (existing private
  fn in `lib.rs`).
- Produces: window label `"onboarding"`, routed to by Task 6's `App.tsx` change. No new commands
  — Task 6's frontend uses the existing `get_settings`/`update_settings` commands to mark
  completion.

- [ ] **Step 1: Add the window label constant**

In `synapse/src-tauri/src/lib.rs`, add alongside the other `*_LABEL` consts near the top:

```rust
const ONBOARDING_LABEL: &str = "onboarding";
```

- [ ] **Step 2: Build the window in `.setup()`**

In `synapse/src-tauri/src/lib.rs`, inside `.setup(|app| { ... })`, after the existing
`settings_window` block (before the `global_shortcut` registrations), add:

```rust
// Unlike the hide-on-close utility windows above, onboarding is one-time:
// closing it (by any means — finishing the wizard or the title-bar X) marks
// onboarding_complete and lets the window actually be destroyed, same as
// Tauri's default close behavior. It's shown automatically on first launch
// and never again after that — there is no "redo onboarding" entry point.
let initial_settings = settings::load(&settings_path(app.handle())?);
let show_onboarding = !initial_settings.onboarding_complete;

let onboarding = WebviewWindowBuilder::new(app, ONBOARDING_LABEL, WebviewUrl::App("index.html".into()))
    .title("Synapse — Setup")
    .inner_size(480.0, 600.0)
    .resizable(false)
    .center()
    .visible(show_onboarding)
    .build()?;
#[cfg(debug_assertions)]
onboarding.open_devtools();

// Closing early (the X button, at any step) is treated the same as
// finishing the wizard: mark onboarding_complete so it doesn't reappear.
// Anything left undone (mic not granted, model not downloaded) stays
// recoverable later — mic via Windows' own Settings, model via
// Settings > Voice. Handled here in Rust rather than relying on frontend
// JS to run on unload, which isn't guaranteed to fire in time.
let onboarding_handle = app.handle().clone();
onboarding.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        if let Ok(path) = settings_path(&onboarding_handle) {
            let mut s = settings::load(&path);
            if !s.onboarding_complete {
                s.onboarding_complete = true;
                if settings::save(&path, &s).is_ok() {
                    let _ = onboarding_handle.emit("settings-changed", s);
                }
            }
        }
    }
});
```

- [ ] **Step 3: Add `"onboarding"` and the mic-settings URL scope to capabilities**

In `synapse/src-tauri/capabilities/default.json`, add `"onboarding"` to the `windows` array, and
add a scoped permission entry (the default `opener:default` only allows `mailto:`/`tel:`/`http:`/
`https:` — `ms-settings:` needs an explicit scope) to `permissions`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for all Synapse windows",
  "windows": ["overlay", "notepad", "snippet-picker", "ai-panel", "settings", "onboarding"],
  "permissions": [
    "core:default",
    "opener:default",
    {
      "identifier": "opener:allow-open-url",
      "allow": [{ "url": "ms-settings:*" }]
    },
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text"
  ]
}
```

- [ ] **Step 4: Build and manually verify the window appears**

Follow PROGRESS.md's dev workflow (`cargo build`, start the vite dev server, launch the built
exe with logging). Since this is a fresh `onboarding_complete: false` default, the onboarding
window should appear automatically alongside/instead of the wheel being immediately usable (it
won't render real content until Task 6 — expect a blank/default wheel render inside the
onboarding window's chrome, since `App.tsx` doesn't route `"onboarding"` yet. That's expected at
this point in the plan).

Run: `cargo build` (from `synapse/src-tauri`)
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add synapse/src-tauri/src/lib.rs synapse/src-tauri/capabilities/default.json
git commit -m "feat: add onboarding window lifecycle"
```

---

## Task 6: Onboarding wizard frontend

**Files:**
- Create: `synapse/src/Onboarding.tsx`
- Create: `synapse/src/Onboarding.css`
- Modify: `synapse/src/App.tsx`

**Interfaces:**
- Consumes: commands `check_mic_access`, `model_status`, `download_model`, `get_settings`,
  `update_settings` (Tasks 1, 3, 4 — all already registered); events
  `model-download-progress`/`model-download-done`/`model-download-error` (Task 3); type
  `Settings` from `synapse/src/models.ts` (extend it — see Step 1).

- [ ] **Step 1: Add `onboarding_complete` to the frontend `Settings` type**

In `synapse/src/models.ts`, add the field to the `Settings` interface:

```typescript
export interface Settings {
  ai: AiSettings;
  onboarding_complete: boolean;
}
```

- [ ] **Step 2: Create `Onboarding.css`**

Create `synapse/src/Onboarding.css`:

```css
.ob-root {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: #1a1a1c;
  color: #eaeaea;
  font-family: -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  padding: 32px;
}

.ob-step {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ob-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.ob-text {
  margin: 0;
  line-height: 1.5;
  opacity: 0.85;
}

.ob-small {
  font-size: 11px;
  opacity: 0.6;
}

.ob-status {
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
}

.ob-ok {
  background: rgba(90, 220, 130, 0.14);
  color: #7fe8a0;
}

.ob-warn {
  background: rgba(255, 160, 80, 0.14);
  color: #ffb877;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.ob-btn {
  align-self: flex-start;
  padding: 9px 16px;
  border-radius: 6px;
  border: none;
  background: rgba(90, 170, 255, 0.85);
  color: #0a0a0c;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.ob-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ob-btn-quiet {
  background: rgba(255, 255, 255, 0.08);
  color: #eaeaea;
}

.ob-link {
  align-self: flex-start;
  background: none;
  border: none;
  color: #9fcaff;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.ob-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
}

.ob-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ob-progress-bar {
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.ob-progress-fill {
  height: 100%;
  background: rgba(90, 170, 255, 0.85);
  transition: width 0.2s ease;
}
```

- [ ] **Step 3: Create `Onboarding.tsx`**

Create `synapse/src/Onboarding.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import "./Onboarding.css";

type Step = "welcome" | "mic" | "model" | "done";
type MicState = "idle" | "checking" | "granted" | "denied";

interface DownloadProgress {
  file: string;
  file_bytes_downloaded: number;
  file_bytes_total: number;
  overall_bytes_downloaded: number;
  overall_bytes_total: number;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

export default function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const [micState, setMicState] = useState<MicState>("idle");
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [modelReady, setModelReady] = useState(false);

  useEffect(() => {
    invoke<boolean>("model_status").then(setModelReady);
  }, []);

  useEffect(() => {
    const unlistenProgress = listen<DownloadProgress>("model-download-progress", (e) => {
      setProgress(e.payload);
    });
    const unlistenDone = listen("model-download-done", () => {
      setDownloading(false);
      setModelReady(true);
    });
    const unlistenError = listen<string>("model-download-error", (e) => {
      setDownloading(false);
      setDownloadError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  async function requestMic() {
    setMicState("checking");
    try {
      await invoke("check_mic_access");
      setMicState("granted");
    } catch {
      setMicState("denied");
    }
  }

  function openMicSettings() {
    openUrl("ms-settings:privacy-microphone");
  }

  function startDownload() {
    setDownloadError("");
    setDownloading(true);
    invoke("download_model");
  }

  async function finish() {
    const settings = await invoke<Settings>("get_settings");
    await invoke("update_settings", { settings: { ...settings, onboarding_complete: true } });
    getCurrentWindow().close();
  }

  return (
    <div className="ob-root">
      {step === "welcome" && (
        <div className="ob-step">
          <h1 className="ob-title">Welcome to Synapse</h1>
          <p className="ob-text">
            Dictation, AI chat, screenshots, snippets, and a notepad — all one hotkey away
            (Ctrl+Alt+Enter). Let's get you set up.
          </p>
          <button className="ob-btn" onClick={() => setStep("mic")}>
            Get Started
          </button>
        </div>
      )}

      {step === "mic" && (
        <div className="ob-step">
          <h1 className="ob-title">Microphone access</h1>
          <p className="ob-text">
            Speech-to-Text needs microphone access to transcribe what you say.
          </p>
          {micState === "granted" && (
            <div className="ob-status ob-ok">Microphone access confirmed.</div>
          )}
          {micState === "denied" && (
            <div className="ob-status ob-warn">
              <span>Windows is blocking microphone access for Synapse.</span>
              <button className="ob-btn ob-btn-quiet" onClick={openMicSettings}>
                Open Privacy Settings
              </button>
            </div>
          )}
          {micState !== "granted" && (
            <button className="ob-btn" onClick={requestMic} disabled={micState === "checking"}>
              {micState === "checking" ? "Checking…" : "Grant Access"}
            </button>
          )}
          <div className="ob-nav">
            <button className="ob-link" onClick={() => setStep("welcome")}>
              Back
            </button>
            <button className="ob-btn" onClick={() => setStep("model")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "model" && (
        <div className="ob-step">
          <h1 className="ob-title">Speech-to-Text model</h1>
          <p className="ob-text">
            Dictation runs fully offline using a local ~690MB model. Download it now, or skip and
            grab it later from Settings → Voice.
          </p>
          {modelReady && <div className="ob-status ob-ok">Model already downloaded.</div>}
          {!modelReady && downloading && progress && (
            <div className="ob-progress">
              <div className="ob-progress-bar">
                <div
                  className="ob-progress-fill"
                  style={{
                    width: `${(100 * progress.overall_bytes_downloaded) / Math.max(progress.overall_bytes_total, 1)}%`,
                  }}
                />
              </div>
              <p className="ob-small">
                {formatMb(progress.overall_bytes_downloaded)} MB / {formatMb(progress.overall_bytes_total)} MB
              </p>
            </div>
          )}
          {downloadError && (
            <div className="ob-status ob-warn">
              <span>{downloadError}</span>
              <button className="ob-btn ob-btn-quiet" onClick={startDownload}>
                Retry
              </button>
            </div>
          )}
          {!modelReady && !downloading && !downloadError && (
            <div className="ob-nav">
              <button className="ob-link" onClick={() => setStep("done")}>
                Skip for now
              </button>
              <button className="ob-btn" onClick={startDownload}>
                Download Now
              </button>
            </div>
          )}
          {modelReady && (
            <div className="ob-nav">
              <span />
              <button className="ob-btn" onClick={() => setStep("done")}>
                Continue
              </button>
            </div>
          )}
        </div>
      )}

      {step === "done" && (
        <div className="ob-step">
          <h1 className="ob-title">You're all set</h1>
          <p className="ob-text">
            Press Ctrl+Alt+Enter anytime to open the wheel, or Ctrl+Alt+D to start dictating
            directly.
          </p>
          <button className="ob-btn" onClick={finish}>
            Open Synapse
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Route to it in `App.tsx`**

In `synapse/src/App.tsx`, add the import and the switch case:

```tsx
import Onboarding from "./Onboarding";
```

```tsx
    case "onboarding":
      return <Onboarding />;
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit` (from `synapse/`)
Expected: no errors.

- [ ] **Step 6: Manual click-through**

Follow PROGRESS.md's dev workflow to build and launch. On a profile with
`onboarding_complete: false` (delete `%APPDATA%\com.synapse.app\settings.json` if testing
repeatedly), confirm:
- Onboarding window opens automatically, showing Welcome.
- Mic step: "Grant Access" resolves to granted or denied appropriately for this machine.
- Model step: if the model isn't already present, "Download Now" shows live progress and
  completes; "Skip for now" advances without downloading.
- Done step: "Open Synapse" closes the window; relaunching the app does NOT reopen onboarding
  (confirms `onboarding_complete` persisted).
- Closing the window early via the title-bar X at any step also prevents onboarding from
  reappearing on the next launch.

- [ ] **Step 7: Commit**

```bash
git add synapse/src/Onboarding.tsx synapse/src/Onboarding.css synapse/src/App.tsx synapse/src/models.ts
git commit -m "feat: add onboarding wizard frontend"
```

---

## Task 7: Settings → Voice section (minimal, "download later" entry point)

**Files:**
- Create: `synapse/src/settings/VoiceSection.tsx`
- Modify: `synapse/src/Settings.tsx`

**Interfaces:**
- Consumes: commands `model_status`, `download_model` (Task 3); events
  `model-download-progress`/`model-download-done`/`model-download-error` (Task 3); existing CSS
  classes `.set-section`, `.set-title`, `.set-row`, `.set-label`, `.set-key`, `.set-badge`,
  `.set-ok`, `.set-missing`, `.set-btn`, `.set-error`, `.set-hint` from `Settings.css`.

- [ ] **Step 1: Create `VoiceSection.tsx`**

Create `synapse/src/settings/VoiceSection.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface DownloadProgress {
  file: string;
  file_bytes_downloaded: number;
  file_bytes_total: number;
  overall_bytes_downloaded: number;
  overall_bytes_total: number;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

export default function VoiceSection() {
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");

  function refresh() {
    invoke<boolean>("model_status").then(setReady);
  }

  useEffect(refresh, []);

  useEffect(() => {
    const unlistenProgress = listen<DownloadProgress>("model-download-progress", (e) =>
      setProgress(e.payload),
    );
    const unlistenDone = listen("model-download-done", () => {
      setDownloading(false);
      setReady(true);
    });
    const unlistenError = listen<string>("model-download-error", (e) => {
      setDownloading(false);
      setError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  function download() {
    setError("");
    setDownloading(true);
    invoke("download_model");
  }

  return (
    <div className="set-section">
      <h2 className="set-title">Voice</h2>

      <div className="set-row">
        <span className="set-label">Model</span>
        <div className="set-key">
          <span className={`set-badge ${ready ? "set-ok" : "set-missing"}`}>
            {ready ? "Downloaded" : "Not downloaded"}
          </span>
          {!downloading && (
            <button className="set-btn" onClick={download}>
              {ready ? "Re-download" : "Download (690MB)"}
            </button>
          )}
        </div>
      </div>

      {downloading && progress && (
        <p className="set-hint">
          Downloading {progress.file}: {formatMb(progress.overall_bytes_downloaded)} MB /{" "}
          {formatMb(progress.overall_bytes_total)} MB
        </p>
      )}
      {error && <div className="set-error">{error}</div>}

      <p className="set-hint">
        Speech-to-Text runs fully offline using this local model — required for dictation.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `Settings.tsx`**

In `synapse/src/Settings.tsx`:

```tsx
import VoiceSection from "./settings/VoiceSection";
```

Change the `SECTIONS` array:

```tsx
const SECTIONS = [
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
] as const;
```

Add the render branch alongside the existing `"ai"` one:

```tsx
        {section === "ai" && <AiSection settings={settings} onChange={update} />}
        {section === "voice" && <VoiceSection />}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` (from `synapse/`)
Expected: no errors.

- [ ] **Step 4: Manual verification**

Launch the app (settings window reachable via the wheel's Settings wedge or the onboarding
deep-link). Confirm the Voice section shows correct status and that clicking Download/Re-download
shows live progress and updates the badge to "Downloaded" on completion, without needing a
restart.

- [ ] **Step 5: Commit**

```bash
git add synapse/src/settings/VoiceSection.tsx synapse/src/Settings.tsx
git commit -m "feat: add minimal Settings > Voice section for the model download"
```

---

## Task 8: Windows `.msi` packaging

**Files:**
- Modify: `synapse/src-tauri/tauri.conf.json`

**Interfaces:**
- None (build configuration only, nothing for other tasks to consume).

- [ ] **Step 1: Narrow the bundle target to `msi`**

In `synapse/src-tauri/tauri.conf.json`, change:

```json
  "bundle": {
    "active": true,
    "targets": "all",
```

to:

```json
  "bundle": {
    "active": true,
    "targets": ["msi"],
```

- [ ] **Step 2: Build the installer**

Run: `npm run tauri build` (from `synapse/`)
Expected: builds the release binary, then the WiX-based `.msi` bundler runs (downloads the WiX
Toolset on first run if not already cached — this can take several minutes over a slow
connection; that's expected, not a failure). Output lands in
`synapse/src-tauri/target/release/bundle/msi/`.

- [ ] **Step 3: Manually verify the installer**

- Double-click the built `.msi` on this machine (or copy it to a clean user profile / VM if
  available). Confirm:
  - SmartScreen shows the expected "unrecognized app" warning (accepted per PRD §8 — not a bug).
  - Install completes without an admin/UAC prompt (per-user install).
  - A Start Menu shortcut named "synapse" (or the configured product name) appears and launches
    the app.
  - Windows Settings → Apps shows "synapse" in the installed list.
  - Uninstalling via Windows Settings → Apps removes the app and its Start Menu shortcut.
- Relaunch after a fresh install (no pre-existing `settings.json`/`model/` from a dev checkout)
  and confirm onboarding runs end-to-end — this is the actual ship-blocker check.

- [ ] **Step 4: Commit**

```bash
git add synapse/src-tauri/tauri.conf.json
git commit -m "build: target Windows .msi installer via Tauri's WiX bundler"
```

---

## Task 9: Update the handoff doc

**Files:**
- Modify: `C:\Users\sahil\Desktop\Synapse\PROGRESS.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Update PROGRESS.md**

Update the "Status" line at the top, the "Known gaps / not yet done" section (remove the M5
sub-project C and M6 bullets, or mark them done with a note on what's verified vs. still
manual-only), and the "Next steps, in order" list (renumber so sub-project B is next). Follow the
same level of detail as the existing "M5 sub-project A" write-up further down the file — add a
parallel "M5 sub-project C + M6 — onboarding, model download, packaging (shipped)" section
summarizing: the onboarding window/lifecycle, the resumable download mechanism and its test
coverage, the Voice settings section, and the `.msi` bundle target — plus which parts still need
a human pass (real download over a real network, a real installer double-click on a clean
profile) if that wasn't done as part of Task 6/8's manual verification.

- [ ] **Step 2: Commit**

```bash
git add PROGRESS.md
git commit -m "docs: update handoff doc for onboarding + model download + msi packaging"
```

---

## Self-Review Notes

- **Spec coverage:** onboarding window/steps (§1) → Tasks 5–6; model download/resume/integrity
  (§2.2) → Task 2–3; Voice section (§2.3) → Task 7; `.msi` packaging (§3) → Task 8; error handling
  (§4) → covered inline across Tasks 2, 3, 6 (retry/resume, size-mismatch rejection, early-close
  handling); testing (§5) → Task 2's mockito tests, Task 1's settings test, manual passes in
  Tasks 6 and 8. Out-of-scope items (§6) are not touched by any task.
- **Type consistency checked:** `DownloadProgress` field names (`file`, `file_bytes_downloaded`,
  `file_bytes_total`, `overall_bytes_downloaded`, `overall_bytes_total`) match exactly between the
  Rust struct (Task 3), `Onboarding.tsx` (Task 6), and `VoiceSection.tsx` (Task 7).
  `asr::preload_model`'s new signature (`PathBuf` argument) is consistent between its Task 3
  definition and both call sites (`.setup()` in Task 3, `download_model`'s `on_success` closure
  also in Task 3).
