//! In-app updates, on top of `tauri-plugin-updater`.
//!
//! The plugin owns the parts that must not be hand-rolled: it fetches the
//! signed `latest.json` manifest from the endpoint in `tauri.conf.json`,
//! verifies the installer's minisign signature against the pinned `pubkey`
//! before anything is executed, compares versions, and runs the installer.
//! A build without a matching private key produces artifacts this app will
//! refuse, which is the property worth having — an unsigned or tampered
//! installer never reaches `Command::spawn`.
//!
//! What is left here is the part the plugin cannot know about: this app's
//! NSIS post-install hook cannot tell an upgrade from a first install, so an
//! update has to leave a breadcrumb for the next launch.

use std::path::Path;

/// Marker written before an update installs and consumed on the next start.
///
/// `installer/hooks.nsh` drops a `.fresh-install` marker on *every* install,
/// upgrades included, and `run()` reads that marker as "show the onboarding
/// wizard". Without this second marker to tell the two apart, every update
/// would drop a long-time user back into first-run setup.
pub const UPDATE_PENDING_MARKER: &str = ".update-pending";

/// Records that the next start follows an in-app update.
///
/// Takes a `&Path` rather than an `AppHandle` so it's testable without a
/// Tauri runtime, same as `settings::load`.
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

/// Where this install gets its updates from.
///
/// The same `synapse.exe` ships in two containers: the signed NSIS installer
/// from GitHub Releases, and an MSIX package from the Microsoft Store. A Store
/// install must never run the self-updater — the Store owns updates for
/// packaged apps, and an NSIS installer run from inside a package would put a
/// second, unmanaged copy next to it. So this is decided at runtime from the
/// process's package identity rather than by a build flag that could drift.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Installed from the NSIS installer; Settings → Updates drives the plugin.
    Direct,
    /// Running from an MSIX package; the Microsoft Store delivers updates.
    Store,
}

/// Returned by the update commands when the Store owns updates. The frontend
/// asks for the channel first and never offers the button, so reaching this
/// means a caller skipped that check.
pub const STORE_MANAGED: &str = "updates for this copy are delivered by the Microsoft Store";

pub fn channel() -> UpdateChannel {
    if is_packaged() {
        UpdateChannel::Store
    } else {
        UpdateChannel::Direct
    }
}

/// True when the process has MSIX package identity. With a zero-length buffer
/// the call reports `ERROR_INSUFFICIENT_BUFFER` for a packaged process and
/// `APPMODEL_ERROR_NO_PACKAGE` for an unpackaged one; only the latter means
/// "not a Store install".
#[cfg(windows)]
fn is_packaged() -> bool {
    use windows::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;

    let mut len = 0u32;
    // SAFETY: a null buffer with length 0 is the documented way to query
    // whether (and how large) a package full name exists.
    let rc = unsafe { GetCurrentPackageFullName(&mut len, None) };
    rc != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
fn is_packaged() -> bool {
    false
}

/// The payload Settings → Updates renders. `version` is only meaningful when
/// `available` is true, but is always populated so the frontend never has to
/// handle a partial shape.
#[derive(serde::Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct UpdateDownloadProgress {
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-updater-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn an_unpackaged_test_process_is_on_the_direct_channel() {
        // `cargo test` never runs with package identity, so this pins the
        // "not packaged" branch of the Win32 check (and the non-Windows stub).
        assert_eq!(channel(), UpdateChannel::Direct);
    }

    #[test]
    fn update_channel_serializes_as_lowercase_for_the_frontend() {
        assert_eq!(serde_json::to_string(&UpdateChannel::Store).unwrap(), "\"store\"");
        assert_eq!(serde_json::to_string(&UpdateChannel::Direct).unwrap(), "\"direct\"");
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
    fn marking_an_update_creates_the_data_dir_if_it_is_missing() {
        // The update dir is created by Tauri on first run, but the marker is
        // written on the way out — this must not be the thing that fails.
        let dir = temp_dir("update-pending-nested").join("not-yet-there");
        mark_update_pending(&dir).expect("marker written into a fresh dir");
        assert!(take_update_pending_marker(&dir));
    }
}
