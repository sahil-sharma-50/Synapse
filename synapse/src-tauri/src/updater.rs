use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// The GitHub repository whose releases drive the update feed. The release
/// side is just the NSIS installer uploaded per release — no manifest, no
/// signature, no updater artifacts. Bumping this is the only change needed
/// if the project ever moves.
///
/// This has to stay the repo the maintainers actually publish from: whatever
/// installer the latest release here carries is what `install_update` runs,
/// silently, on every user's machine.
pub const REPO: &str = "sahil-sharma-50/Synapse";

/// GitHub's REST API root for repository resources. Split out so the command
/// layer and the background download resolve releases through the same base.
pub const API_BASE: &str = "https://api.github.com/repos";

/// GitHub's REST API rejects requests without a User-Agent header (403),
/// so every call must set one.
const USER_AGENT: &str = "Synapse-updater";

/// Hosts GitHub serves release assets from. `browser_download_url` points at
/// `github.com`, which redirects to one of the `githubusercontent.com` asset
/// hosts — reqwest follows that itself, but the initial URL is the one worth
/// pinning.
const ALLOWED_ASSET_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// Whether `url` is an HTTPS URL on a GitHub asset host.
///
/// The downloaded file is executed, so the download target is checked rather
/// than assumed even though it came back from GitHub's own API: this is the
/// last point where a wrong URL is still just bytes. Hand-rolled instead of
/// pulling in a URL parser — the crate has no `url` dependency of its own and
/// the grammar needed here is "scheme, then authority, then a delimiter".
fn is_allowed_asset_url(url: &str) -> bool {
    // Plain http is refused outright: an installer is exactly the payload a
    // network attacker would want to swap.
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // `https://github.com@evil.example/x` has a real host of `evil.example`.
    // Rather than re-implement userinfo parsing, refuse the shape entirely —
    // no legitimate GitHub asset URL carries credentials.
    if authority.contains('@') {
        return false;
    }
    let host = authority.split(':').next().unwrap_or("");
    // Exact match, so neither `github.com.evil.example` nor `notgithub.com`
    // slips through a `ends_with`-style check.
    ALLOWED_ASSET_HOSTS
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
}

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

    if !is_allowed_asset_url(&asset.browser_download_url) {
        return Err("release installer is not hosted on GitHub".to_string());
    }

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
/// depend on whatever the release happened to name the asset.
pub const INSTALLER_NAME: &str = "synapse-setup.exe";

/// Marker written before the installer is launched and consumed on the next
/// start, so a launch that follows an in-app update can be told apart from
/// one that follows a first install.
pub const UPDATE_PENDING_MARKER: &str = ".update-pending";

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
///
/// The download target is re-resolved here rather than accepted as an
/// argument. `install_update` executes whatever this writes, so the URL must
/// not be reachable from the webview: any script running in a Synapse window
/// (the AI panel renders model output, notes render user text) could otherwise
/// invoke `download_update` with a URL of its choosing and then
/// `install_update`, and that is arbitrary code execution rather than a bad
/// update. The extra API call is one request against a check the user just
/// made by hand.
pub fn spawn_update_download(app: tauri::AppHandle) {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let dir = update_dir(&app)?;
            let client = reqwest::blocking::Client::new();
            let info = check_for_update(&client, API_BASE, REPO, env!("CARGO_PKG_VERSION"))?;
            if !info.available {
                return Err("already on the latest version".to_string());
            }
            // Re-checked here even though `check_for_update` already refused
            // anything off-GitHub: this is the call that produces the file
            // `install_update` executes, so the invariant is asserted at the
            // boundary that depends on it rather than inherited from a caller.
            if !is_allowed_asset_url(&info.download_url) {
                return Err("refusing to download an installer from a non-GitHub URL".to_string());
            }
            let expected_size = info.file_size;
            download_installer(&client, &info.download_url, &dir, expected_size, |downloaded| {
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
///
/// Any previously downloaded installer is left in place until the new one has
/// arrived intact (`rename` replaces it), so a failed retry does not throw
/// away a working installer the user could still have installed.
/// Pure transport: the caller (`spawn_update_download`) is what decides the
/// URL is one this app is willing to execute the contents of.
fn download_installer(
    client: &reqwest::blocking::Client,
    url: &str,
    dir: &Path,
    expected_size: u64,
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    let final_path = dir.join(INSTALLER_NAME);
    let part_path = dir.join(format!("{INSTALLER_NAME}.part"));
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

/// Records that the next start follows an in-app update.
///
/// The NSIS post-install hook drops a `.fresh-install` marker on *every*
/// install, upgrades included (see `installer/hooks.nsh`), and that marker
/// forces the onboarding wizard. Without this second marker to distinguish
/// them, every in-app update would drop the user back into first-run setup.
///
/// Takes a `&Path` so it's testable without a Tauri runtime, same as
/// `settings::load`.
pub fn mark_update_pending(data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join(UPDATE_PENDING_MARKER), b"").map_err(|e| e.to_string())
}

/// True exactly once after an in-app update, then cleared — `remove_file`
/// both answers "was it there?" and consumes it, same as
/// `take_fresh_install_marker`.
pub fn take_update_pending_marker(dir: &Path) -> bool {
    std::fs::remove_file(dir.join(UPDATE_PENDING_MARKER)).is_ok()
}

/// Runs the downloaded installer silently and relaunches the app afterwards.
///
/// NSIS's `/S` suppresses the finish page — and with it the "Run Synapse"
/// checkbox that would otherwise restart the app — so the relaunch is chained
/// on explicitly. Without it the app would simply vanish on update, which is
/// indistinguishable from a crash. `current_exe()` is the right target because
/// a `currentUser` NSIS install replaces the binary in place.
#[cfg(windows)]
fn spawn_install_and_relaunch(installer: &Path, app_exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Console applications spawned from a GUI process flash a window without
    // this. Not combined with DETACHED_PROCESS: Windows documents
    // CREATE_NO_WINDOW as ignored when the two are used together.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // `raw_arg`, not `arg`: Rust quotes arguments per the C runtime's rules,
    // which is not what cmd.exe parses. cmd strips the outermost pair of
    // quotes from a /C string containing more than two quotes, which is what
    // makes the doubled quoting below correct.
    let command = format!(
        r#"/C ""{}" /S && start "" "{}"""#,
        installer.display(),
        app_exe.display()
    );
    std::process::Command::new("cmd.exe")
        .raw_arg(command)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("could not launch installer: {e}"))?;
    Ok(())
}

/// The release feed only ever carries the Windows NSIS installer; this arm
/// exists so the crate still compiles on macOS, and is untested there like
/// every other macOS path in this project.
#[cfg(not(windows))]
fn spawn_install_and_relaunch(installer: &Path, _app_exe: &Path) -> Result<(), String> {
    std::process::Command::new(installer)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("could not launch installer: {e}"))?;
    Ok(())
}

/// Launches the downloaded installer and exits the app so the install isn't
/// fighting a live process holding its own binary. Fails loudly (return
/// value) if there's nothing to run — everything after the spawn is
/// unobservable from here, since the app is on its way out.
pub fn launch_installer(app: tauri::AppHandle) -> Result<(), String> {
    let installer = installer_path(&app)?;
    if !installer.is_file() {
        return Err("no downloaded installer found".to_string());
    }
    let app_exe = std::env::current_exe().map_err(|e| format!("could not locate the running app: {e}"))?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Before the spawn, not after: once the installer is running, this
    // process may be terminated at any moment.
    mark_update_pending(&data_dir)?;
    spawn_install_and_relaunch(&installer, &app_exe)?;

    // Short, because the sooner this process is gone the sooner NSIS can
    // replace its binary without having to kill it first. Nothing is racing
    // the exit — the installer is chained inside its own detached cmd, so it
    // proceeds whether or not this app has finished shutting down.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
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
                        { "name": "Synapse_0.1.0_x64-setup.exe", "browser_download_url": "https://github.com/owner/repo/releases/download/v0.2.0/old.exe", "size": 1 },
                        { "name": "Synapse_0.2.0_x64-setup.exe", "browser_download_url": "https://github.com/owner/repo/releases/download/v0.2.0/new.exe", "size": 123456 }
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
            info.download_url, "https://github.com/owner/repo/releases/download/v0.2.0/new.exe",
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
                        { "name": "Synapse_0.1.1_x64-setup.exe", "browser_download_url": "https://github.com/owner/repo/releases/download/v0.1.1/same.exe", "size": 42 }
                    ]
                }"#,
            )
            .create();

        let client = reqwest::blocking::Client::new();
        let info = check_for_update(&client, &server.url(), "owner/repo", "0.1.1").expect("check succeeds");

        assert!(!info.available);
    }

    #[test]
    fn github_asset_urls_are_allowed() {
        assert!(is_allowed_asset_url(
            "https://github.com/sahil-sharma-50/Synapse/releases/download/v0.2.0/Synapse_0.2.0_x64-setup.exe"
        ));
        assert!(is_allowed_asset_url("https://objects.githubusercontent.com/x/y.exe"));
        assert!(
            is_allowed_asset_url("https://GitHub.com/x.exe"),
            "host match is case-insensitive"
        );
    }

    #[test]
    fn non_github_and_insecure_urls_are_rejected() {
        assert!(
            !is_allowed_asset_url("http://github.com/x.exe"),
            "plain http is refused"
        );
        assert!(!is_allowed_asset_url("https://evil.example/x.exe"));
        assert!(
            !is_allowed_asset_url("https://github.com.evil.example/x.exe"),
            "a suffix-shaped lookalike host is not github.com"
        );
        assert!(
            !is_allowed_asset_url("https://notgithub.com/x.exe"),
            "a prefix-shaped lookalike host is not github.com"
        );
        assert!(
            !is_allowed_asset_url("https://github.com@evil.example/x.exe"),
            "userinfo makes the real host the part after the @"
        );
        assert!(
            !is_allowed_asset_url("https://evil.example/https://github.com/x.exe"),
            "github.com in the path is not github.com"
        );
        assert!(!is_allowed_asset_url("file:///C:/evil.exe"));
    }

    #[test]
    fn errors_when_the_installer_asset_is_not_on_github() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/owner/repo/releases/latest")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "tag_name": "v0.2.0",
                    "assets": [
                        { "name": "Synapse_0.2.0_x64-setup.exe", "browser_download_url": "https://evil.example/x.exe", "size": 10 }
                    ]
                }"#,
            )
            .create();

        let client = reqwest::blocking::Client::new();
        let result = check_for_update(&client, &server.url(), "owner/repo", "0.1.1");

        assert!(
            result.is_err(),
            "an off-GitHub installer URL is refused, not downloaded"
        );
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
    fn a_failed_retry_keeps_the_previously_downloaded_installer() {
        let mut server = mockito::Server::new();
        let _m = server.mock("GET", "/installer.exe").with_status(500).create();

        let dir = temp_dir("installer-keeps-previous");
        std::fs::write(dir.join(INSTALLER_NAME), b"a good installer").expect("seed installer");

        let url = format!("{}/installer.exe", server.url());
        let client = reqwest::blocking::Client::new();
        let result = download_installer(&client, &url, &dir, 100, |_| {});

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(dir.join(INSTALLER_NAME)).unwrap(),
            b"a good installer",
            "a failed retry must not throw away an installer the user could still install"
        );
    }

    #[test]
    fn update_pending_marker_is_reported_once_then_consumed() {
        let dir = temp_dir("update-pending");
        assert!(!take_update_pending_marker(&dir), "absent before an update is staged");

        mark_update_pending(&dir).expect("marker written");
        assert!(take_update_pending_marker(&dir), "the launch after an update sees it");
        assert!(
            !take_update_pending_marker(&dir),
            "and every launch after that does not"
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
