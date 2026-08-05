use crate::ids::{new_id, now_ms};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Clipboard history: what the user copied, newest first, with deliberately
/// saved items pinned above it.
///
/// PRIVACY, stated plainly: this file is a persistent record of everything
/// copied on this machine, which will include passwords, recovery codes and
/// API keys. That is the behaviour the product owner chose with the tradeoff
/// spelled out. The mitigations are that it can be turned off entirely
/// (`settings.clipboard.history_enabled`), cleared in one action, and deleted
/// per entry — and that Synapse's own clipboard writes are never recorded.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ClipEntry {
    pub id: String,
    pub text: String,
    /// Unix milliseconds.
    pub copied_at: i64,
    /// Pinned entries survive eviction and sort above the history.
    #[serde(default)]
    pub pinned: bool,
    /// Only set for entries the user named — i.e. the snippets migrated in
    /// from the old snippets.json. Auto-captured copies have no name.
    #[serde(default)]
    pub name: Option<String>,
}

/// Bounded so the file can't grow without limit on a machine that stays up for
/// months. Pinned entries are never counted out.
const MAX_ENTRIES: usize = 500;

/// Anything larger is a document, not a clip: storing it would bloat the file
/// and the picker could never render it usefully anyway.
const MAX_TEXT_BYTES: usize = 64 * 1024;

/// Decides what the history should become after `text` was copied, or `None`
/// if this copy should not be recorded at all.
///
/// Pure and free of Tauri, so the eviction and de-duplication rules can be
/// tested without a running app — the same split `settings::load` uses.
pub fn record(mut list: Vec<ClipEntry>, text: &str, now: i64) -> Option<Vec<ClipEntry>> {
    if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
        return None;
    }

    // De-dupe anywhere in the list, not just against the head: re-copying
    // something from three days ago should promote that entry rather than
    // leave two identical rows in the picker.
    if let Some(pos) = list.iter().position(|e| e.text == text) {
        let mut existing = list.remove(pos);
        existing.copied_at = now;
        list.insert(0, existing);
        return Some(list);
    }

    list.insert(
        0,
        ClipEntry {
            id: new_id(),
            text: text.to_string(),
            copied_at: now,
            pinned: false,
            name: None,
        },
    );

    // Evict from the tail, skipping pinned entries — a user who pinned
    // something meant to keep it, and silently dropping it after 500 copies
    // would be a data-loss bug that takes weeks to notice.
    if list.iter().filter(|e| !e.pinned).count() > MAX_ENTRIES {
        let mut unpinned_seen = 0;
        list.retain(|e| {
            if e.pinned {
                return true;
            }
            unpinned_seen += 1;
            unpinned_seen <= MAX_ENTRIES
        });
    }

    Some(list)
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("clipboard.json"))
}

pub fn read_store(path: &Path) -> Vec<ClipEntry> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_else(|e| {
        eprintln!("[synapse] clipboard.json unreadable ({e}) — starting empty");
        Vec::new()
    })
}

pub fn write_store(path: &Path, entries: &[ClipEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<ClipEntry>, String> {
    Ok(read_store(&store_path(app)?))
}

pub fn save(app: &tauri::AppHandle, entries: &[ClipEntry]) -> Result<(), String> {
    write_store(&store_path(app)?, entries)
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let mut entries = list(app)?;
    entries.retain(|e| e.id != id);
    save(app, &entries)
}

/// Clears the auto-captured history but keeps pinned entries, which the user
/// created deliberately. "Clear history" that also silently destroyed saved
/// snippets would be an unpleasant surprise.
pub fn clear_history(app: &tauri::AppHandle) -> Result<(), String> {
    let mut entries = list(app)?;
    entries.retain(|e| e.pinned);
    save(app, &entries)
}

pub fn set_pinned(app: &tauri::AppHandle, id: &str, pinned: bool) -> Result<(), String> {
    let mut entries = list(app)?;
    if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
        entry.pinned = pinned;
    }
    save(app, &entries)
}

pub fn add_pinned(app: &tauri::AppHandle, name: String, text: String) -> Result<ClipEntry, String> {
    let mut entries = list(app)?;
    let entry = ClipEntry {
        id: new_id(),
        text,
        copied_at: now_ms(),
        pinned: true,
        name: if name.trim().is_empty() { None } else { Some(name) },
    };
    entries.insert(0, entry.clone());
    save(app, &entries)?;
    Ok(entry)
}

/// Folds a legacy `snippets.json` into the clipboard store as pinned entries.
///
/// Ordering is load-bearing: the new store is written first and only then is
/// the legacy file renamed (never deleted). A crash in between re-runs the
/// migration next launch, which the id/text guard makes a no-op.
pub fn migrate_snippets(dir: &Path) -> Result<(), String> {
    #[derive(Deserialize)]
    struct LegacySnippet {
        name: String,
        content: String,
    }

    let legacy = dir.join("snippets.json");
    if !legacy.is_file() {
        return Ok(());
    }
    let Ok(raw) = std::fs::read_to_string(&legacy) else {
        return Ok(());
    };
    let snippets: Vec<LegacySnippet> = serde_json::from_str(&raw).unwrap_or_default();

    let store = dir.join("clipboard.json");
    let mut entries = read_store(&store);
    let now = now_ms();
    for s in snippets {
        if entries.iter().any(|e| e.text == s.content) {
            continue;
        }
        entries.push(ClipEntry {
            id: new_id(),
            text: s.content,
            copied_at: now,
            pinned: true,
            name: Some(s.name),
        });
    }

    write_store(&store, &entries)?;
    let _ = std::fs::rename(&legacy, dir.join("snippets.json.migrated"));
    Ok(())
}

/// Polls `GetClipboardSequenceNumber` rather than registering a clipboard
/// format listener.
///
/// A listener needs an HWND with a running message pump, which here would mean
/// subclassing a Tauri window's wndproc — the exact approach that already
/// failed in this codebase (WRY silently re-subclasses the overlay, and the
/// registered messages never arrived). The sequence number is a single
/// non-blocking call with no window, no thread affinity and no pump; reading
/// the clipboard itself only happens on an actual change.
#[cfg(target_os = "windows")]
pub fn spawn_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    const POLL_MS: u64 = 400;

    std::thread::spawn(move || {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));

            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq {
                continue;
            }
            last_seq = seq;

            // Read per tick rather than caching: the toggle has to take effect
            // without a restart, and the watcher has no way to listen for the
            // settings-changed event from a plain thread.
            let enabled = crate::settings_path(&app)
                .map(|p| crate::settings::load(&p).clipboard.history_enabled)
                .unwrap_or(true);
            if !enabled {
                continue;
            }

            // Our own paste-and-restore writes are not things the user copied.
            if crate::inject::is_suppressed() {
                continue;
            }

            // A non-text clip (image, files) or a clipboard another app is
            // currently holding open. Skip; never retry in a tight loop.
            let Ok(text) = app.clipboard().read_text() else {
                continue;
            };

            if crate::inject::matches_self_write(&text) {
                continue;
            }

            let Ok(path) = store_path(&app) else { continue };
            if let Some(next) = record(read_store(&path), &text, now_ms()) {
                if let Err(e) = write_store(&path, &next) {
                    eprintln!("[synapse] could not save clipboard history: {e}");
                    continue;
                }
                let _ = app.emit("clipboard-changed", ());
            }
        }
    });
}

/// macOS has no `GetClipboardSequenceNumber` equivalent wired up yet, and this
/// dev machine has no Mac to verify a polling read against. Better an honestly
/// absent feature than an untested one that silently logs the pasteboard.
#[cfg(not(target_os = "windows"))]
pub fn spawn_watcher(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str, pinned: bool) -> ClipEntry {
        ClipEntry {
            id: new_id(),
            text: text.to_string(),
            copied_at: 0,
            pinned,
            name: None,
        }
    }

    #[test]
    fn records_a_new_copy_at_the_front() {
        let list = record(vec![entry("old", false)], "new", 100).expect("recorded");
        assert_eq!(list[0].text, "new");
        assert_eq!(list[1].text, "old");
        assert_eq!(list[0].copied_at, 100);
    }

    #[test]
    fn skips_whitespace_only_copies() {
        assert!(record(Vec::new(), "   \n\t ", 0).is_none());
        assert!(record(Vec::new(), "", 0).is_none());
    }

    #[test]
    fn skips_oversized_copies() {
        let huge = "x".repeat(MAX_TEXT_BYTES + 1);
        assert!(record(Vec::new(), &huge, 0).is_none());
    }

    /// Re-copying something old should move it up, not create a duplicate row.
    #[test]
    fn moves_an_existing_entry_to_the_front_instead_of_duplicating() {
        let list = vec![entry("a", false), entry("b", false), entry("c", false)];
        let next = record(list, "c", 500).expect("recorded");
        assert_eq!(next.len(), 3, "no duplicate added");
        assert_eq!(next[0].text, "c");
        assert_eq!(next[0].copied_at, 500, "timestamp refreshed to the newest copy");
        assert_eq!(next[1].text, "a");
    }

    #[test]
    fn caps_unpinned_entries_at_the_maximum() {
        let mut list: Vec<ClipEntry> = (0..MAX_ENTRIES).map(|i| entry(&format!("entry {i}"), false)).collect();
        list = record(list, "one more", 1).expect("recorded");
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].text, "one more");
        assert!(
            !list.iter().any(|e| e.text == format!("entry {}", MAX_ENTRIES - 1)),
            "the oldest unpinned entry was evicted"
        );
    }

    #[test]
    fn never_evicts_pinned_entries() {
        let mut list = vec![entry("keep me", true)];
        list.extend((0..MAX_ENTRIES).map(|i| entry(&format!("entry {i}"), false)));

        let next = record(list, "one more", 1).expect("recorded");
        assert!(
            next.iter().any(|e| e.text == "keep me"),
            "a pinned entry survives eviction regardless of age"
        );
        assert_eq!(
            next.iter().filter(|e| !e.pinned).count(),
            MAX_ENTRIES,
            "only unpinned entries count against the cap"
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-clip-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn migrates_snippets_as_pinned_entries_and_keeps_the_legacy_file() {
        let dir = temp_dir("migrate");
        std::fs::write(
            dir.join("snippets.json"),
            r#"[{"id":"1","name":"Signature","content":"Best,\nSahil"}]"#,
        )
        .expect("write legacy snippets");

        migrate_snippets(&dir).expect("migrate");

        let entries = read_store(&dir.join("clipboard.json"));
        assert_eq!(entries.len(), 1);
        assert!(entries[0].pinned, "snippets arrive pinned, not as history");
        assert_eq!(entries[0].name.as_deref(), Some("Signature"));
        assert_eq!(entries[0].text, "Best,\nSahil");

        assert!(
            !dir.join("snippets.json").exists(),
            "legacy file is moved out of the way"
        );
        assert!(
            dir.join("snippets.json.migrated").exists(),
            "and is preserved rather than deleted"
        );
    }

    #[test]
    fn migration_is_idempotent() {
        let dir = temp_dir("migrate-twice");
        std::fs::write(
            dir.join("snippets.json"),
            r#"[{"id":"1","name":"A","content":"hello"}]"#,
        )
        .expect("write legacy snippets");

        migrate_snippets(&dir).expect("first");
        // Simulate the crash-between-write-and-rename case.
        std::fs::write(
            dir.join("snippets.json"),
            r#"[{"id":"1","name":"A","content":"hello"}]"#,
        )
        .expect("restore legacy snippets");
        migrate_snippets(&dir).expect("second");

        assert_eq!(read_store(&dir.join("clipboard.json")).len(), 1);
    }

    #[test]
    fn migration_is_a_no_op_without_a_legacy_file() {
        let dir = temp_dir("migrate-none");
        migrate_snippets(&dir).expect("migrate");
        assert!(!dir.join("clipboard.json").exists());
    }
}
