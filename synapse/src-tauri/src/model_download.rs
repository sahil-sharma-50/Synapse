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
        let server = mockito::Server::new();
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
