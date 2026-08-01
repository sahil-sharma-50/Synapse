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

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// Verified against the real release asset (20260728 tag, CPython 3.12.13,
/// x86_64-pc-windows-msvc, `install_only` build) by downloading and
/// inspecting it. This archive's
/// root already contains a top-level `python/` directory (paths inside the
/// tarball are `python/python.exe`, `python/Lib/...`, etc.), which is why
/// `extract_python_archive` below unpacks into `env_dir` (the parent of
/// `python_dir`) rather than into `python_dir` itself.
const PYTHON_BUILD_STANDALONE_URL: &str = "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.12.13+20260728-x86_64-pc-windows-msvc-install_only.tar.gz";

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

            // Stage 1: Python runtime.
            let client = reqwest::blocking::Client::new();
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
            // The archive's own root already contains `python/...` (verified
            // by downloading and inspecting the real asset), so unpack into
            // `env_dir` (python_dir's parent), NOT into `python_dir` itself —
            // unpacking into `python_dir` would nest everything one level too
            // deep as `python_dir/python/python.exe`.
            extract_python_archive(&env_dir.join(file_name), &env_dir)?;

            // Stage 2: pip install torch (CPU) + pocket-tts. This build's
            // `python/Scripts/` has no `pip.exe` shim (pip is only importable
            // as a library), so pip is invoked via `python.exe -m pip`.
            let python_exe = python_dir.join("python.exe");
            let _ = app.emit(
                "tts-setup-progress",
                SetupProgress { stage: "packages".to_string(), bytes_downloaded: 0, bytes_total: 0 },
            );
            // torch itself isn't pinned tightly: the CPU wheel index only
            // ever serves torch builds compatible with this Python version,
            // and the feature only needs torch's stable public tensor API.
            // A `2.x` floor/ceiling is enough to avoid a hypothetical
            // breaking `3.0` release without pinning to a specific patch
            // that will inevitably fall off the CPU wheel index.
            run_pip_install(
                &python_exe,
                &["torch>=2.0,<3.0", "--index-url", "https://download.pytorch.org/whl/cpu"],
            )?;
            // Pinned exactly (unlike torch above): the sidecar script
            // imports `pocket_tts.data.audio.stream_audio_chunks`, an
            // internal module path that pocket-tts does not document or
            // guarantee as public API.
            // Only 2.1.0 has been verified against that import; a future
            // release could rename/move the module and silently fall back
            // to OS TTS with no diagnosable error.
            run_pip_install(&python_exe, &["pocket-tts==2.1.0"])?;

            // Stage 3: pre-warm model weights with a throwaway request so the
            // first real "speak" doesn't pay the Hugging Face download cost.
            let _ = app.emit(
                "tts-setup-progress",
                SetupProgress { stage: "weights".to_string(), bytes_downloaded: 0, bytes_total: 0 },
            );
            let scratch = tts_scratch_dir(&app)?;
            prewarm_weights(&python_exe, &sidecar_script_path(&app)?, &scratch)?;

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

/// Unpacks a python-build-standalone `install_only` archive. Its tarball
/// root already contains a top-level `python/` directory, so `dest` here is
/// meant to be the *parent* of the final `python/` directory (i.e. `env_dir`,
/// not `python_dir`) — see the comment at the `spawn_setup` call site.
fn extract_python_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(dest).map_err(|e| e.to_string())
}

/// This python-build-standalone build ships no `Scripts/pip.exe` shim (pip is
/// only present as an importable library), so pip must be invoked through the
/// interpreter itself via `-m pip`, not as a standalone executable.
/// Windows allocates and flashes a visible console window when a
/// console-subsystem binary (`python.exe`) is spawned from a GUI app with no
/// console of its own — `CREATE_NO_WINDOW` suppresses that. No-op on other
/// platforms.
fn suppress_console_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn run_pip_install(python: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(python);
    cmd.arg("-m").arg("pip").arg("install").args(args);
    suppress_console_window(&mut cmd);
    let status = cmd.status().map_err(|e| format!("failed to run pip: {e}"))?;
    if !status.success() {
        return Err(format!("pip install {args:?} exited with {status}"));
    }
    Ok(())
}

fn prewarm_weights(python: &Path, sidecar_script: &Path, scratch_dir: &Path) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};

    let mut cmd = std::process::Command::new(python);
    cmd.arg(sidecar_script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());
    suppress_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

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

    // `wait()` alone only tells us the process exited, not that synthesis
    // actually succeeded — if `pip install pocket-tts` half-succeeded and
    // `import pocket_tts` raises inside the sidecar, Python can still exit
    // non-zero *or* the sidecar's own crash-proofing can print a
    // `{"status":"error",...}` line and exit zero. Read the sidecar's
    // response line (same protocol `tts_pocket.rs` uses) and require both a
    // clean exit and an "ok" status before treating prewarm as successful —
    // otherwise `spawn_setup` would write the READY marker over a broken
    // environment and every future `speak()` would silently fall back to OS
    // TTS with the real cause lost.
    let mut response_line = String::new();
    let read_result = if let Some(stdout) = child.stdout.take() {
        BufReader::new(stdout).read_line(&mut response_line).map_err(|e| e.to_string())
    } else {
        Err("prewarm sidecar stdout unavailable".to_string())
    };

    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out_path);

    if !status.success() {
        return Err(format!("prewarm sidecar exited with {status}"));
    }
    read_result?;
    let response = crate::tts_pocket::decode_response(response_line.trim())
        .map_err(|e| format!("prewarm sidecar produced no valid response: {e}"))?;
    if response.status != "ok" {
        return Err(response
            .message
            .unwrap_or_else(|| "prewarm sidecar reported failure".to_string()));
    }
    Ok(())
}
