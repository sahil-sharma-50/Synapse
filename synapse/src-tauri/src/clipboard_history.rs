use crate::ids::{new_id, now_ms};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use tauri::Manager;

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
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub asset_path: Option<String>,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub byte_size: u64,
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

fn default_kind() -> String {
    "text".to_string()
}

fn classify_text(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.contains(char::is_whitespace) && (trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        "link".to_string()
    } else {
        default_kind()
    }
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
            kind: classify_text(text),
            asset_path: None,
            file_paths: Vec::new(),
            byte_size: text.len() as u64,
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

pub fn enforce_retention(list: Vec<ClipEntry>, now: i64, retention_days: u32, max_unpinned: usize) -> Vec<ClipEntry> {
    let cutoff = now.saturating_sub(i64::from(retention_days) * 24 * 60 * 60 * 1000);
    let mut unpinned = 0usize;
    list.into_iter()
        .filter(|entry| entry.pinned || entry.copied_at >= cutoff)
        .filter(|entry| {
            if entry.pinned {
                return true;
            }
            unpinned += 1;
            unpinned <= max_unpinned
        })
        .collect()
}

pub fn enforce_storage_limit(list: Vec<ClipEntry>, max_bytes: u64) -> Vec<ClipEntry> {
    let mut used = 0u64;
    list.into_iter()
        .filter(|entry| {
            if entry.pinned {
                return true;
            }
            if used.saturating_add(entry.byte_size) > max_bytes {
                return false;
            }
            used = used.saturating_add(entry.byte_size);
            true
        })
        .collect()
}

fn remove_evicted_assets(before: &[ClipEntry], after: &[ClipEntry]) {
    for entry in before {
        if after.iter().any(|kept| kept.id == entry.id) {
            continue;
        }
        if let Some(path) = &entry.asset_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn remove_orphaned_assets(dir: &Path, entries: &[ClipEntry]) {
    let assets = dir.join("clipboard-assets");
    let Ok(files) = std::fs::read_dir(assets) else { return };
    for file in files.flatten() {
        let path = file.path();
        if entries.iter().any(|entry| entry.asset_path.as_deref() == path.to_str()) {
            continue;
        }
        let _ = std::fs::remove_file(path);
    }
}

fn record_files(mut list: Vec<ClipEntry>, paths: Vec<String>, now: i64) -> Option<Vec<ClipEntry>> {
    if paths.is_empty() {
        return None;
    }
    let fingerprint = paths.join("\n");
    if let Some(position) = list
        .iter()
        .position(|entry| entry.kind == "files" && entry.text == fingerprint)
    {
        let mut entry = list.remove(position);
        entry.copied_at = now;
        list.insert(0, entry);
        return Some(list);
    }
    let label = if paths.len() == 1 {
        Path::new(&paths[0])
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&paths[0])
            .to_string()
    } else {
        format!("{} files", paths.len())
    };
    list.insert(
        0,
        ClipEntry {
            id: new_id(),
            text: fingerprint,
            kind: "files".into(),
            asset_path: None,
            file_paths: paths,
            byte_size: 0,
            copied_at: now,
            pinned: false,
            name: Some(label),
        },
    );
    Some(list)
}

fn record_bitmap(mut list: Vec<ClipEntry>, bytes: &[u8], asset_path: String, now: i64) -> Option<Vec<ClipEntry>> {
    if bytes.is_empty() {
        return None;
    }
    let fingerprint = format!(
        "bitmap:{}:{}",
        bytes.len(),
        bytes
            .iter()
            .take(64)
            .fold(0u64, |sum, byte| sum.wrapping_mul(16777619) ^ u64::from(*byte))
    );
    if let Some(position) = list
        .iter()
        .position(|entry| entry.kind == "image" && entry.text == fingerprint)
    {
        let mut entry = list.remove(position);
        entry.copied_at = now;
        list.insert(0, entry);
        return Some(list);
    }
    list.insert(
        0,
        ClipEntry {
            id: new_id(),
            text: fingerprint,
            kind: "image".into(),
            asset_path: Some(asset_path),
            file_paths: Vec::new(),
            byte_size: bytes.len() as u64,
            copied_at: now,
            pinned: false,
            name: Some("Copied image".into()),
        },
    );
    Some(list)
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
    let connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    let mut statement = connection.prepare("SELECT id, text_content, kind, asset_path, file_paths_json, byte_size, copied_at, is_pinned, name FROM clipboard_items ORDER BY is_pinned DESC, copied_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let paths: String = row.get(4)?;
            Ok(ClipEntry {
                id: row.get(0)?,
                text: row.get(1)?,
                kind: row.get(2)?,
                asset_path: row.get(3)?,
                file_paths: serde_json::from_str(&paths).unwrap_or_default(),
                byte_size: row.get::<_, i64>(5)? as u64,
                copied_at: row.get(6)?,
                pinned: row.get::<_, i64>(7)? != 0,
                name: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn save(app: &tauri::AppHandle, entries: &[ClipEntry]) -> Result<(), String> {
    let mut connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM clipboard_items", [])
        .map_err(|error| error.to_string())?;
    for entry in entries {
        insert_entry(&transaction, entry)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    if let Some(dir) = crate::storage::app_path(app)?.parent() {
        remove_orphaned_assets(dir, entries);
    }
    Ok(())
}

fn insert_entry(connection: &rusqlite::Connection, entry: &ClipEntry) -> Result<(), String> {
    connection.execute(
        "INSERT OR REPLACE INTO clipboard_items (id, text_content, kind, asset_path, file_paths_json, byte_size, copied_at, is_pinned, name) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![entry.id, entry.text, entry.kind, entry.asset_path, serde_json::to_string(&entry.file_paths).unwrap_or_else(|_| "[]".into()), entry.byte_size as i64, entry.copied_at, entry.pinned, entry.name],
    ).map(|_| ()).map_err(|error| error.to_string())
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
    let byte_size = text.len() as u64;
    let entry = ClipEntry {
        id: new_id(),
        text,
        kind: default_kind(),
        asset_path: None,
        file_paths: Vec::new(),
        byte_size,
        copied_at: now_ms(),
        pinned: true,
        name: if name.trim().is_empty() { None } else { Some(name) },
    };
    entries.insert(0, entry.clone());
    save(app, &entries)?;
    Ok(entry)
}

pub fn asset_bytes(app: &tauri::AppHandle, id: &str) -> Result<Vec<u8>, String> {
    let entry = list(app)?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("no clipboard item with id {id}"))?;
    let path = entry
        .asset_path
        .ok_or_else(|| "clipboard item has no image".to_string())?;
    std::fs::read(path).map_err(|error| error.to_string())
}

pub fn storage_bytes(app: &tauri::AppHandle) -> Result<u64, String> {
    Ok(list(app)?.iter().map(|entry| entry.byte_size).sum())
}

#[cfg(target_os = "windows")]
pub fn paste_entry(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let entry = list(app)?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("no clipboard item with id {id}"))?;
    match entry.kind.as_str() {
        "files" => crate::inject::paste_files(app, &entry.file_paths),
        "image" => {
            let path = entry
                .asset_path
                .ok_or_else(|| "clipboard image is missing".to_string())?;
            let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
            crate::inject::paste_bitmap(app, &bytes)
        }
        _ => crate::inject::paste_text(app, &entry.text),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn paste_entry(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let entry = list(app)?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("no clipboard item with id {id}"))?;
    crate::inject::paste_text(app, &entry.text)
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
            kind: default_kind(),
            asset_path: None,
            file_paths: Vec::new(),
            byte_size: 0,
            copied_at: now,
            pinned: true,
            name: Some(s.name),
        });
    }

    write_store(&store, &entries)?;
    let _ = std::fs::rename(&legacy, dir.join("snippets.json.migrated"));
    Ok(())
}

pub fn migrate_json_store(dir: &Path) -> Result<(), String> {
    let legacy = dir.join("clipboard.json");
    if !legacy.is_file() {
        return Ok(());
    }
    let entries = read_store(&legacy);
    let connection = crate::storage::open(&dir.join("synapse.db"))?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM clipboard_items", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if count == 0 {
        for entry in &entries {
            insert_entry(&connection, entry)?;
        }
    }
    std::fs::rename(&legacy, dir.join("clipboard.json.migrated")).map_err(|error| error.to_string())
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
                .map(|p| crate::settings::load(&p).clipboard)
                .unwrap_or_default();
            if !enabled.history_enabled {
                continue;
            }

            // Our own paste-and-restore writes are not things the user copied.
            if crate::inject::is_suppressed() {
                continue;
            }

            let Ok(data_dir) = app.path().app_data_dir() else {
                continue;
            };
            let current = list(&app).unwrap_or_default();
            let now = now_ms();
            let next = if enabled.capture_files {
                clipboard_win::get_clipboard::<Vec<String>, _>(clipboard_win::formats::FileList)
                    .ok()
                    .and_then(|paths| record_files(current.clone(), paths, now))
            } else {
                None
            };
            let next = if next.is_none() && enabled.capture_images {
                clipboard_win::get_clipboard::<Vec<u8>, _>(clipboard_win::formats::Bitmap)
                    .ok()
                    .and_then(|bytes| {
                        let assets = data_dir.join("clipboard-assets");
                        std::fs::create_dir_all(&assets).ok()?;
                        let asset = assets.join(format!("{}.bmp", new_id()));
                        std::fs::write(&asset, &bytes).ok()?;
                        record_bitmap(current.clone(), &bytes, asset.to_string_lossy().into_owned(), now)
                    })
            } else {
                next
            };
            let next = if next.is_none() && (enabled.capture_text || enabled.capture_links) {
                app.clipboard().read_text().ok().and_then(|text| {
                    if crate::inject::matches_self_write(&text) {
                        return None;
                    }
                    let kind = classify_text(&text);
                    if (kind == "text" && !enabled.capture_text) || (kind == "link" && !enabled.capture_links) {
                        return None;
                    }
                    record(current.clone(), &text, now)
                })
            } else {
                next
            };

            if let Some(next) = next {
                let next = enforce_retention(next, now, enabled.retention_days, enabled.max_unpinned_items);
                let next = enforce_storage_limit(next, enabled.max_storage_mb.saturating_mul(1024 * 1024));
                remove_evicted_assets(&current, &next);
                if let Err(e) = save(&app, &next) {
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
            kind: classify_text(text),
            asset_path: None,
            file_paths: Vec::new(),
            byte_size: text.len() as u64,
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
    fn recognises_links_without_treating_arbitrary_text_as_a_url() {
        let url = record(Vec::new(), "https://example.com/docs", 10).expect("record url");
        assert_eq!(url[0].kind, "link");
        let sentence = record(Vec::new(), "see example.com later", 11).expect("record sentence");
        assert_eq!(sentence[0].kind, "text");
    }

    #[test]
    fn retention_removes_expired_unpinned_items_but_keeps_pins() {
        let day = 24 * 60 * 60 * 1000;
        let list = vec![
            ClipEntry {
                copied_at: day,
                ..entry("expired", false)
            },
            ClipEntry {
                copied_at: day,
                ..entry("pinned", true)
            },
            ClipEntry {
                copied_at: 40 * day,
                ..entry("recent", false)
            },
        ];
        let kept = enforce_retention(list, 40 * day, 30, 500);
        assert_eq!(
            kept.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(),
            vec!["pinned", "recent"]
        );
    }

    #[test]
    fn storage_limit_evicts_old_unpinned_assets_and_exempts_pins() {
        let mut pinned = entry("pinned image", true);
        pinned.byte_size = 8;
        let mut newest = entry("new image", false);
        newest.byte_size = 6;
        let mut oldest = entry("old image", false);
        oldest.byte_size = 6;
        let kept = enforce_storage_limit(vec![pinned, newest, oldest], 10);
        assert_eq!(
            kept.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(),
            vec!["pinned image", "new image"]
        );
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

    #[test]
    fn migrates_clipboard_json_into_sqlite_and_preserves_the_backup() {
        let dir = temp_dir("json-to-sqlite");
        let legacy = entry("Saved clip", true);
        write_store(&dir.join("clipboard.json"), std::slice::from_ref(&legacy)).expect("seed json");

        migrate_json_store(&dir).expect("migrate json");

        let connection = crate::storage::open(&dir.join("synapse.db")).expect("open database");
        let stored: String = connection
            .query_row(
                "SELECT text_content FROM clipboard_items WHERE id = ?1",
                [&legacy.id],
                |row| row.get(0),
            )
            .expect("migrated row");
        assert_eq!(stored, "Saved clip");
        assert!(dir.join("clipboard.json.migrated").is_file());
    }
}
