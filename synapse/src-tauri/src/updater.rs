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
