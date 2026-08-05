use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// The GitHub repository whose releases drive the update feed. The release
/// side is just the NSIS installer uploaded per release — no manifest, no
/// signature, no updater artifacts. Bumping this is the only change needed
/// if the project ever moves.
pub const REPO: &str = "anirudh1804/Synapse";

/// GitHub's REST API rejects requests without a User-Agent header (403),
/// so every call must set one.
const USER_AGENT: &str = "Synapse-updater";

/// The payload a user-facing "check for updates" renders. `download_url` and
/// `file_size` are only meaningful when `available` is true, but are always
/// populated so the frontend never has to handle a partial shape.
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub download_url: String,
    pub file_size: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// Splits a version string into its numeric components. A leading `v`/`V`
/// is stripped, and any non-numeric segments (`-beta`, `+build`) are
/// dropped, so `0.2.0-beta` and `0.2.0` compare as equal.
fn parse(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split(['.', '-', '+'])
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

/// Numeric component-wise comparison, padding the shorter version with zeros
/// (`0.1` == `0.1.0`).
fn version_cmp(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// True when `remote` is a newer version than `current`. Numeric, not
/// lexicographic: `0.10.0` is newer than `0.9.9`.
pub fn is_newer_than(remote: &str, current: &str) -> bool {
    version_cmp(&parse(remote), &parse(current)) == std::cmp::Ordering::Greater
}

/// Queries the GitHub Releases API for `repo`'s latest release and reports
/// whether it is newer than `current`.
///
/// `client` and `api_base` are injectable so tests can point at a local
/// mockito server instead of github.com — same "pure, testable" pattern as
/// `model_download::remote_file_size`.
pub fn check_for_update(
    client: &reqwest::blocking::Client,
    api_base: &str,
    repo: &str,
    current: &str,
) -> Result<UpdateInfo, String> {
    let url = format!("{api_base}/{repo}/releases/latest");
    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .map_err(|e| format!("update check failed: {e}"))?;

    match response.status() {
        reqwest::StatusCode::NOT_FOUND => return Err("no releases found for this repo".to_string()),
        status if !status.is_success() => {
            return Err(format!("update check failed: server returned {status}"));
        }
        _ => {}
    }

    let release: GithubRelease = response
        .json()
        .map_err(|e| format!("update check failed: unreadable release payload: {e}"))?;

    // GitHub does not guarantee asset order, and a release may carry more
    // than one installer (e.g. a leftover from an earlier version). Prefer
    // the installer whose name carries the release's own version, so the
    // newest setup.exe wins; fall back to any setup.exe, then any .exe.
    let version_tag = release.tag_name.trim_start_matches('v');
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with("setup.exe") && a.name.contains(version_tag))
        .or_else(|| release.assets.iter().find(|a| a.name.ends_with("setup.exe")))
        .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".exe")))
        .ok_or_else(|| "latest release has no installer asset".to_string())?;

    let available = is_newer_than(&release.tag_name, current);

    Ok(UpdateInfo {
        current_version: current.trim_start_matches('v').to_string(),
        latest_version: release.tag_name.trim_start_matches('v').to_string(),
        available,
        download_url: asset.browser_download_url.clone(),
        file_size: asset.size,
    })
}

/// Fixed name the downloaded installer is written under in the update dir.
/// Deliberately not the release's real filename: `install_update` must not
/// depend on whatever the friend named the asset.
pub const INSTALLER_NAME: &str = "synapse-setup.exe";

/// `app_data_dir()/update/` — the installer's staging directory.
pub fn update_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The path `install_update` will launch.
pub fn installer_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(update_dir(app)?.join(INSTALLER_NAME))
}

#[derive(Serialize, Clone)]
pub struct UpdateDownloadProgress {
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
}

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// Downloads the installer on a background thread; idempotent while a
/// download is already in flight. Progress/success/failure are reported via
/// Tauri events, not a return value, since the work happens off-thread —
/// same shape as `model_download::spawn_download`.
pub fn spawn_update_download(app: tauri::AppHandle, url: String, expected_size: u64) {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let dir = update_dir(&app)?;
            let client = reqwest::blocking::Client::new();
            download_installer(&client, &url, &dir, expected_size, |downloaded| {
                let _ = app.emit(
                    "update-download-progress",
                    UpdateDownloadProgress {
                        bytes_downloaded: downloaded,
                        bytes_total: expected_size,
                    },
                );
            })
        })();

        DOWNLOADING.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                println!("[synapse] update installer downloaded");
                let _ = app.emit("update-download-done", ());
            }
            Err(e) => {
                eprintln!("[synapse] update download failed: {e}");
                let _ = app.emit("update-download-error", e);
            }
        }
    });
}

/// Downloads `url` into `dir/<INSTALLER_NAME>` as a fresh download, streaming
/// byte counts through `on_progress`.
///
/// `client`, `dir` and `expected_size` are injectable so tests can run
/// against a mockito server with no Tauri runtime. Downloads to
/// `INSTALLER_NAME.part` and renames on success, so a partial download is
/// never mistaken for a complete installer; a transfer shorter than
/// `expected_size` (0 = don't check) is rejected and the partial cleaned up.
/// Every attempt re-downloads from scratch — the installer is only a few MB,
/// so resumability is not worth the complexity.
fn download_installer(
    client: &reqwest::blocking::Client,
    url: &str,
    dir: &Path,
    expected_size: u64,
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    let final_path = dir.join(INSTALLER_NAME);
    let part_path = dir.join(format!("{INSTALLER_NAME}.part"));
    let _ = std::fs::remove_file(&final_path);
    let _ = std::fs::remove_file(&part_path);

    let mut response = client.get(url).send().map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed: server returned {}", response.status()));
    }

    let mut out = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = response.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        on_progress(downloaded);
    }
    drop(out);

    if expected_size > 0 && downloaded != expected_size {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "download incomplete: got {downloaded} bytes, expected {expected_size}"
        ));
    }

    std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Launches the downloaded installer with NSIS's `/S` (silent) flag, then
/// exits the app after a beat so the installer isn't fighting a live
/// process. Fails loudly (return value) if there's nothing to run; the
/// actual install + relaunch happens on the next launch.
pub fn launch_installer(app: tauri::AppHandle) -> Result<(), String> {
    let installer = installer_path(&app)?;
    if !installer.is_file() {
        return Err("no downloaded installer found".to_string());
    }

    std::process::Command::new(&installer)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("could not launch installer: {e}"))?;

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        app.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_version_is_detected() {
        assert!(is_newer_than("v0.2.0", "0.1.1"));
        assert!(is_newer_than("0.2.0", "v0.1.1"), "v prefix is ignored");
        assert!(is_newer_than("0.10.0", "0.9.9"), "numeric compare, not lexicographic");
        assert!(is_newer_than("0.2.0-beta", "0.1.1"), "pre-release suffix parses");
    }

    #[test]
    fn same_version_is_not_newer() {
        assert!(!is_newer_than("0.1.1", "0.1.1"));
        assert!(!is_newer_than("v0.1.1", "0.1.1"));
        assert!(!is_newer_than("0.2.0-beta", "0.2.0"));
    }

    #[test]
    fn older_version_is_not_newer() {
        assert!(!is_newer_than("0.1.0", "0.1.1"));
    }

    #[test]
    fn non_numeric_versions_compare_as_zero() {
        assert!(!is_newer_than("banana", "apple"), "both parse to []");
    }

    #[test]
    fn finds_setup_exe_asset_and_reports_available() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/owner/repo/releases/latest")
            .match_header("user-agent", USER_AGENT)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "tag_name": "v0.2.0",
                    "assets": [
                        { "name": "Synapse_0.1.0_x64-setup.exe", "browser_download_url": "https://example.com/old.exe", "size": 1 },
                        { "name": "Synapse_0.2.0_x64-setup.exe", "browser_download_url": "https://example.com/new.exe", "size": 123456 }
                    ]
                }"#,
            )
            .create();

        let client = reqwest::blocking::Client::new();
        let info = check_for_update(&client, &server.url(), "owner/repo", "0.1.1").expect("check succeeds");

        assert!(info.available);
        assert_eq!(info.current_version, "0.1.1");
        assert_eq!(info.latest_version, "0.2.0");
        assert_eq!(
            info.download_url, "https://example.com/new.exe",
            "newest setup.exe wins"
        );
        assert_eq!(info.file_size, 123456);
    }

    #[test]
    fn reports_not_available_when_current_is_latest() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/owner/repo/releases/latest")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "tag_name": "v0.1.1",
                    "assets": [
                        { "name": "Synapse_0.1.1_x64-setup.exe", "browser_download_url": "https://example.com/same.exe", "size": 42 }
                    ]
                }"#,
            )
            .create();

        let client = reqwest::blocking::Client::new();
        let info = check_for_update(&client, &server.url(), "owner/repo", "0.1.1").expect("check succeeds");

        assert!(!info.available);
    }

    #[test]
    fn errors_when_no_release_exists() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/owner/repo/releases/latest")
            .with_status(404)
            .create();

        let client = reqwest::blocking::Client::new();
        let result = check_for_update(&client, &server.url(), "owner/repo", "0.1.1");

        assert!(result.is_err(), "a repo with no releases is surfaced as an error");
    }

    #[test]
    fn errors_when_release_has_no_installer_asset() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/owner/repo/releases/latest")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "tag_name": "v0.2.0",
                    "assets": [
                        { "name": "README.md", "browser_download_url": "https://example.com/readme", "size": 10 }
                    ]
                }"#,
            )
            .create();

        let client = reqwest::blocking::Client::new();
        let result = check_for_update(&client, &server.url(), "owner/repo", "0.1.1");

        assert!(result.is_err(), "a release without an installer cannot be updated from");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-updater-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn downloads_installer_and_renames_part_to_final() {
        let mut server = mockito::Server::new();
        let body = b"fake installer bytes ".repeat(8);
        let _m = server
            .mock("GET", "/installer.exe")
            .with_status(200)
            .with_body(body.as_slice())
            .create();

        let dir = temp_dir("installer-basic");
        let url = format!("{}/installer.exe", server.url());
        let client = reqwest::blocking::Client::new();
        let mut progress = Vec::new();
        download_installer(&client, &url, &dir, body.len() as u64, |d| progress.push(d)).expect("download succeeds");

        assert_eq!(std::fs::read(dir.join(INSTALLER_NAME)).unwrap(), body.as_slice());
        assert!(
            !dir.join(format!("{INSTALLER_NAME}.part")).exists(),
            "part file is renamed away"
        );
        assert_eq!(
            *progress.last().unwrap(),
            body.len() as u64,
            "progress reaches the final byte count"
        );
    }

    #[test]
    fn short_download_is_rejected_against_expected_size() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/installer.exe")
            .with_status(200)
            .with_body("short body")
            .create();

        let dir = temp_dir("installer-truncated");
        let url = format!("{}/installer.exe", server.url());
        let client = reqwest::blocking::Client::new();
        let result = download_installer(&client, &url, &dir, 1000, |_| {});

        assert!(result.is_err(), "a transfer short of the expected size is rejected");
        assert!(!dir.join(INSTALLER_NAME).exists(), "no final installer on failure");
        assert!(
            !dir.join(format!("{INSTALLER_NAME}.part")).exists(),
            "partial file is cleaned up, not left to be mistaken for an installer"
        );
    }

    #[test]
    fn server_error_status_is_an_error() {
        let mut server = mockito::Server::new();
        let _m = server.mock("GET", "/installer.exe").with_status(500).create();

        let dir = temp_dir("installer-500");
        let url = format!("{}/installer.exe", server.url());
        let client = reqwest::blocking::Client::new();
        let result = download_installer(&client, &url, &dir, 100, |_| {});

        assert!(result.is_err());
        assert!(!dir.join(INSTALLER_NAME).exists());
    }
}
