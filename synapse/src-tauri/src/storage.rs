use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS folders (
               id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS notes (
               id TEXT PRIMARY KEY,
               plain_text TEXT NOT NULL DEFAULT '',
               document_json TEXT NOT NULL DEFAULT '',
               color TEXT NOT NULL DEFAULT 'amber',
               x INTEGER, y INTEGER, width INTEGER NOT NULL DEFAULT 320, height INTEGER NOT NULL DEFAULT 320,
               is_open INTEGER NOT NULL DEFAULT 0,
               is_favorite INTEGER NOT NULL DEFAULT 0,
               folder TEXT,
               tags_json TEXT NOT NULL DEFAULT '[]',
               trashed_at INTEGER,
               revision INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tags (
               id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS note_tags (
               note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
               tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY(note_id, tag_id)
             );
             CREATE TABLE IF NOT EXISTS note_attachments (
               id TEXT PRIMARY KEY,
               note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
               file_name TEXT NOT NULL, managed_path TEXT NOT NULL, mime_type TEXT,
               byte_size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS clipboard_items (
               id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               text_content TEXT NOT NULL DEFAULT '',
               asset_path TEXT,
               byte_size INTEGER NOT NULL DEFAULT 0,
               copied_at INTEGER NOT NULL,
               is_pinned INTEGER NOT NULL DEFAULT 0,
               name TEXT,
               file_paths_json TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE IF NOT EXISTS clipboard_files (
               item_id TEXT NOT NULL REFERENCES clipboard_items(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               original_path TEXT NOT NULL,
               PRIMARY KEY(item_id, ordinal)
             );
             CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes(updated_at DESC);
             CREATE INDEX IF NOT EXISTS clipboard_copied_idx ON clipboard_items(copied_at DESC);",
        )
        .map_err(|error| error.to_string())
}

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    initialize(&connection)?;
    Ok(connection)
}

pub fn app_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("synapse.db"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_the_complete_notes_and_clipboard_schema_in_wal_mode() {
        let connection = rusqlite::Connection::open_in_memory().expect("open database");
        initialize(&connection).expect("initialize schema");

        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("query tables")
            .query_map([], |row| row.get(0))
            .expect("map tables")
            .collect::<Result<_, _>>()
            .expect("collect tables");
        for expected in [
            "clipboard_files",
            "clipboard_items",
            "folders",
            "note_attachments",
            "note_tags",
            "notes",
            "tags",
        ] {
            assert!(tables.iter().any(|table| table == expected), "missing {expected}");
        }
        assert_eq!(
            connection
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
