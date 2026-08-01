use std::io::{Read, Write};
use std::path::Path;

#[allow(dead_code)]
pub const MODEL_FILES: [&str; 4] = [
    "config.json",
    "decoder_joint-model.onnx",
    "encoder-model.onnx",
    "vocab.txt",
];

#[allow(dead_code)]
pub const MODEL_REPO_BASE: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main";

/// True only when every required model file is present. A partial `.part`
/// file left over from an interrupted download does not count.
#[allow(dead_code)]
pub fn is_downloaded(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|f| dir.join(f).is_file())
}

/// Downloads one file into `dir/<file>`, resuming from `dir/<file>.part` if
/// present. A no-op if `dir/<file>` already exists. `on_progress(bytes_downloaded,
/// bytes_total)` fires after every chunk read. `base_url` is injectable so
/// tests can point at a local mock server instead of huggingface.co.
#[allow(dead_code)]
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
