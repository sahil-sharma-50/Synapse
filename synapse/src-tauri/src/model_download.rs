use std::io::{Read, Write};
use std::path::Path;

/// The int8 variants are deliberate: the repo's fp32 `encoder-model.onnx` is a
/// 42MB graph stub whose weights live in a separate 2.4GB
/// `encoder-model.onnx.data`, so downloading it alone produces a model that
/// fails to load with "External data path does not exist". The int8 encoder is
/// self-contained and parakeet-rs resolves both of these names on its own.
///
/// The user-facing download size lives in one place only — `ASR_MODEL.sizeLabel`
/// in `src/models.ts`. This comment used to quote ~650MB while the UI button
/// said ~630 MB; don't reintroduce a second number here.
pub const MODEL_FILES: [&str; 4] = [
    "config.json",
    "decoder_joint-model.int8.onnx",
    "encoder-model.int8.onnx",
    "vocab.txt",
];

/// Leftovers from the earlier fp32 file list. These have to be deleted rather
/// than ignored: parakeet-rs prefers `encoder-model.onnx` over the int8 name,
/// so a stale stub on disk shadows a perfectly good download and dictation
/// stays broken.
pub const STALE_MODEL_FILES: [&str; 3] = [
    "encoder-model.onnx",
    "encoder-model.onnx.data",
    "decoder_joint-model.onnx",
];

/// Best-effort — a file that can't be removed (locked, permissions) is not
/// worth failing a download over; the load error it may cause is already
/// reported separately.
pub fn remove_stale_files(dir: &Path) {
    for file in STALE_MODEL_FILES {
        let path = dir.join(file);
        if path.is_file() {
            match std::fs::remove_file(&path) {
                Ok(()) => println!("[synapse] removed stale model file {file}"),
                Err(e) => eprintln!("[synapse] could not remove stale model file {file}: {e}"),
            }
        }
    }
}

pub const MODEL_REPO_BASE: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main";

/// True only when every required model file is present. A partial `.part`
/// file left over from an interrupted download does not count.
pub fn is_downloaded(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|f| dir.join(f).is_file())
}

/// Size of `base_url/<file>` on the server, without downloading it.
///
/// Reads the length off the response *headers* rather than calling
/// `Response::content_length()`: on a HEAD request that method reports the
/// body length, which is always 0 for a bodiless HEAD reply. The old code
/// summed those zeros into an overall total of 0, so the download UI showed
/// "12 MB / 0 MB". Hugging Face additionally reports `X-Linked-Size` for
/// LFS/Xet-backed files, which is the authoritative size and survives the
/// redirect chain, so it wins when present.
pub fn remote_file_size(client: &reqwest::blocking::Client, base_url: &str, file: &str) -> Result<u64, String> {
    let url = format!("{base_url}/{file}");
    let response = client
        .head(&url)
        .send()
        .map_err(|e| format!("{file}: HEAD failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{file}: server returned {}", response.status()));
    }
    let headers = response.headers();
    ["x-linked-size", "content-length"]
        .iter()
        .filter_map(|name| headers.get(*name))
        .filter_map(|v| v.to_str().ok()?.parse::<u64>().ok())
        .find(|size| *size > 0)
        .ok_or_else(|| format!("{file}: server did not report a size"))
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
    let response = request.send().map_err(|e| format!("{file}: request failed: {e}"))?;
    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // A full-size `.part` file left over from a process that died
        // between the final `write_all` and the rename to `final_path`
        // requests a range starting at (or past) the resource's end, which
        // a spec-compliant server answers with 416. There is nothing left
        // to download — the `.part` file is already complete, so promote it
        // directly instead of failing forever with no way to recover short
        // of a human deleting the file by hand.
        return std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string());
    }
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
        let n = reader.read(&mut buf).map_err(|e| format!("{file}: read failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        on_progress(downloaded, total);
    }

    if downloaded != total {
        return Err(format!(
            "{file}: got {downloaded} bytes, expected {total} - connection likely dropped"
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
            remove_stale_files(&dir);
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
                file_totals.push(remote_file_size(&client, MODEL_REPO_BASE, file)?);
            }
            let overall_total: u64 = file_totals.iter().sum();

            let mut overall_base: u64 = 0;
            for (i, file) in MODEL_FILES.iter().enumerate() {
                let app_for_progress = app.clone();
                let base = overall_base;
                let file_name = file.to_string();
                download_one_file(
                    &client,
                    MODEL_REPO_BASE,
                    &dir,
                    file,
                    move |file_downloaded, file_total| {
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
                    },
                )?;
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
        download_one_file(&client, &server.url(), &dir, "vocab.txt", |_, _| {}).expect("resumed download succeeds");

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

    #[test]
    fn stale_fp32_files_are_removed_and_current_ones_are_kept() {
        let dir = temp_dir("stale");
        std::fs::write(dir.join("encoder-model.onnx"), b"fp32 stub").unwrap();
        std::fs::write(dir.join("decoder_joint-model.onnx"), b"fp32").unwrap();
        std::fs::write(dir.join("encoder-model.int8.onnx"), b"int8").unwrap();
        std::fs::write(dir.join("vocab.txt"), b"words").unwrap();

        remove_stale_files(&dir);

        assert!(!dir.join("encoder-model.onnx").exists());
        assert!(!dir.join("decoder_joint-model.onnx").exists());
        assert!(dir.join("encoder-model.int8.onnx").exists(), "int8 files survive");
        assert!(dir.join("vocab.txt").exists(), "shared files survive");
    }

    #[test]
    fn remote_size_comes_from_headers_not_the_empty_head_body() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("HEAD", "/encoder-model.onnx")
            .with_status(200)
            .with_header("content-length", "41770866")
            .create();

        let client = reqwest::blocking::Client::new();
        let size = remote_file_size(&client, &server.url(), "encoder-model.onnx").expect("size probe succeeds");

        // reqwest's `Response::content_length()` would report 0 here (a HEAD
        // reply carries no body), which is what made the UI show "/ 0 MB".
        assert_eq!(size, 41_770_866);
    }

    #[test]
    fn remote_size_prefers_x_linked_size_for_lfs_backed_files() {
        let mut server = mockito::Server::new();
        // How Hugging Face answers for an LFS/Xet file: the pointer's own
        // length in Content-Length, the real file size in X-Linked-Size.
        let _m = server
            .mock("HEAD", "/decoder_joint-model.onnx")
            .with_status(200)
            .with_header("content-length", "990")
            .with_header("x-linked-size", "12345678")
            .create();

        let client = reqwest::blocking::Client::new();
        let size = remote_file_size(&client, &server.url(), "decoder_joint-model.onnx").expect("size probe succeeds");

        assert_eq!(size, 12_345_678);
    }

    #[test]
    fn remote_size_errors_when_no_usable_size_header_is_present() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("HEAD", "/vocab.txt")
            .with_status(200)
            .with_header("content-length", "0")
            .create();

        let client = reqwest::blocking::Client::new();
        let result = remote_file_size(&client, &server.url(), "vocab.txt");

        // Better to fail loudly than to sum a bogus 0 into the overall total
        // and render a progress bar against a denominator of zero.
        assert!(result.is_err(), "a zero size is treated as no size at all");
    }

    #[test]
    fn already_complete_part_file_is_promoted_without_re_downloading() {
        let mut server = mockito::Server::new();
        let full = b"0123456789ABCDEF";

        let dir = temp_dir("already-complete-part");
        std::fs::write(dir.join("vocab.txt.part"), full).unwrap();

        // The `.part` file is already the full size, so a resume request
        // asks for a range starting at (or past) the end of the resource.
        // A spec-compliant server has nothing left to send and answers 416;
        // no body is registered here, proving the fix never needs the mock
        // to actually serve any bytes.
        let _m = server
            .mock("GET", "/vocab.txt")
            .match_header("range", format!("bytes={}-", full.len()).as_str())
            .with_status(416)
            .create();

        let client = reqwest::blocking::Client::new();
        download_one_file(&client, &server.url(), &dir, "vocab.txt", |_, _| {})
            .expect("leftover complete .part file is promoted, not treated as an error");

        assert_eq!(std::fs::read(dir.join("vocab.txt")).unwrap(), full);
        assert!(!dir.join("vocab.txt.part").exists(), "part file is renamed away");
    }
}
