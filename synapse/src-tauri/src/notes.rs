use crate::ids::{new_id, now_ms};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

/// One sticky note. Each gets its own OS window, so the geometry lives here
/// rather than in a window-manager side table — a note and where it sits on the
/// desk are the same object as far as the user is concerned.
///
/// Every field carries a serde default, per the same forward/backward-compat
/// rule `settings.rs` documents: a notes.json written by a future build must
/// still load here, and vice versa.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub content: String,
    /// ProseMirror JSON. Empty means this note predates the rich editor and
    /// should be initialized from `content` on first open.
    #[serde(default)]
    pub document: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub trashed_at: Option<i64>,
    #[serde(default = "default_color")]
    pub color: String,
    /// Physical pixels, outer position. Physical rather than logical because
    /// `outer_position()` reports physical, and mixing the two drifts on any
    /// scaled display.
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default = "default_w")]
    pub w: u32,
    #[serde(default = "default_h")]
    pub h: u32,
    /// Whether a window for this note was open at last exit, so the desk comes
    /// back the way it was left.
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

pub const COLORS: [&str; 5] = ["amber", "rose", "sky", "mint", "slate"];

fn default_color() -> String {
    COLORS[0].to_string()
}
fn default_w() -> u32 {
    320
}
fn default_h() -> u32 {
    320
}

impl Default for Note {
    fn default() -> Self {
        Self {
            id: new_id(),
            content: String::new(),
            document: String::new(),
            revision: 0,
            favorite: false,
            folder: None,
            tags: Vec::new(),
            trashed_at: None,
            color: default_color(),
            x: None,
            y: None,
            w: default_w(),
            h: default_h(),
            open: false,
            created_at: now_ms(),
            updated_at: now_ms(),
        }
    }
}

impl Note {
    /// Derived, never stored — a title field would immediately drift from the
    /// text it is supposed to summarise.
    pub fn title(&self) -> String {
        let line = self
            .content
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("");
        if line.is_empty() {
            return "New note".to_string();
        }
        let mut out: String = line.chars().take(40).collect();
        if line.chars().count() > 40 {
            out.push('…');
        }
        out
    }
}

pub fn read_store(path: &Path) -> Vec<Note> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str(&content) {
        Ok(notes) => notes,
        Err(e) => {
            // Back the file up before anything overwrites it. Silently starting
            // the user from zero notes is the worst possible failure here.
            eprintln!("[synapse] notes.json unparseable ({e}) — backing up and starting empty");
            let backup = path.with_extension("json.bak");
            if let Err(e) = std::fs::write(&backup, &content) {
                eprintln!("[synapse] failed to back up unparseable notes: {e}");
            }
            Vec::new()
        }
    }
}

pub fn write_store(path: &Path, notes: &[Note]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(notes).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn sql_revision(revision: u64) -> Result<i64, String> {
    i64::try_from(revision).map_err(|_| format!("note revision {revision} exceeds SQLite integer range"))
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<Note>, String> {
    let connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    let mut statement = connection
        .prepare("SELECT id, plain_text, document_json, color, x, y, width, height, is_open, created_at, updated_at, revision, is_favorite, folder, tags_json, trashed_at FROM notes ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let tags: String = row.get(14)?;
            let revision: i64 = row.get(11)?;
            let revision =
                u64::try_from(revision).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(11, revision))?;
            Ok(Note {
                id: row.get(0)?,
                content: row.get(1)?,
                document: row.get(2)?,
                color: row.get(3)?,
                x: row.get(4)?,
                y: row.get(5)?,
                w: row.get(6)?,
                h: row.get(7)?,
                open: row.get::<_, i64>(8)? != 0,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                revision,
                favorite: row.get::<_, i64>(12)? != 0,
                folder: row.get(13)?,
                tags: serde_json::from_str(&tags).unwrap_or_default(),
                trashed_at: row.get(15)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn get(app: &tauri::AppHandle, id: &str) -> Result<Note, String> {
    list(app)?
        .into_iter()
        .find(|n| n.id == id)
        .ok_or_else(|| format!("no note with id {id}"))
}

pub fn create(app: &tauri::AppHandle, color: Option<String>) -> Result<Note, String> {
    let note = Note {
        color: color
            .filter(|c| COLORS.contains(&c.as_str()))
            .unwrap_or_else(default_color),
        ..Default::default()
    };
    let connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    insert_or_replace(&connection, &note)?;
    Ok(note)
}

/// Content and geometry get separate read-modify-write updaters rather than one
/// `update(note)`. The textarea autosaves on a debounce while a drag saves on
/// its own cadence; a single whole-struct write would let each clobber the
/// other's in-flight value.
fn update_note(app: &tauri::AppHandle, id: &str, f: impl FnOnce(&mut Note)) -> Result<(), String> {
    let mut note = get(app, id)?;
    f(&mut note);
    note.updated_at = now_ms();
    let connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    insert_or_replace(&connection, &note)
}

fn insert_or_replace(connection: &rusqlite::Connection, note: &Note) -> Result<(), String> {
    let revision = sql_revision(note.revision)?;
    connection.execute(
        "INSERT OR REPLACE INTO notes (id, plain_text, document_json, color, x, y, width, height, is_open, created_at, updated_at, revision, is_favorite, folder, tags_json, trashed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        rusqlite::params![note.id, note.content, note.document, note.color, note.x, note.y, note.w, note.h, note.open, note.created_at, note.updated_at, revision, note.favorite, note.folder, serde_json::to_string(&note.tags).unwrap_or_else(|_| "[]".into()), note.trashed_at],
    ).map(|_| ()).map_err(|error| error.to_string())
}

pub fn update_content(app: &tauri::AppHandle, id: &str, content: String) -> Result<(), String> {
    update_note(app, id, |n| n.content = content)
}

fn update_document_checked(
    note: &mut Note,
    document: String,
    plain_text: String,
    expected_revision: u64,
) -> Result<u64, String> {
    if note.revision != expected_revision {
        return Err(format!(
            "revision conflict: expected {expected_revision}, current {}",
            note.revision
        ));
    }
    serde_json::from_str::<serde_json::Value>(&document).map_err(|error| format!("invalid note document: {error}"))?;
    note.document = document;
    note.content = plain_text;
    note.revision += 1;
    note.updated_at = now_ms();
    Ok(note.revision)
}

pub fn update_document(
    app: &tauri::AppHandle,
    id: &str,
    document: String,
    plain_text: String,
    expected_revision: u64,
) -> Result<u64, String> {
    let mut note = get(app, id)?;
    let revision = update_document_checked(&mut note, document, plain_text, expected_revision)?;
    let connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    insert_or_replace(&connection, &note)?;
    Ok(revision)
}

pub fn set_favorite(app: &tauri::AppHandle, id: &str, favorite: bool) -> Result<(), String> {
    update_note(app, id, |note| note.favorite = favorite)
}

pub fn move_to_trash(app: &tauri::AppHandle, id: &str, trashed: bool) -> Result<(), String> {
    update_note(app, id, |note| note.trashed_at = trashed.then(now_ms))
}

pub fn organize(app: &tauri::AppHandle, id: &str, folder: Option<String>, tags: Vec<String>) -> Result<(), String> {
    update_note(app, id, |note| {
        note.folder = folder.filter(|value| !value.trim().is_empty());
        note.tags = tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .take(12)
            .collect();
    })
}

pub fn update_geometry(app: &tauri::AppHandle, id: &str, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    update_note(app, id, |n| {
        n.x = Some(x);
        n.y = Some(y);
        n.w = w;
        n.h = h;
    })
}

pub fn update_color(app: &tauri::AppHandle, id: &str, color: String) -> Result<(), String> {
    if !COLORS.contains(&color.as_str()) {
        return Err(format!("unknown note color {color}"));
    }
    update_note(app, id, |n| n.color = color)
}

pub fn set_open(app: &tauri::AppHandle, id: &str, open: bool) -> Result<(), String> {
    update_note(app, id, |n| n.open = open)
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let connection = crate::storage::open(&crate::storage::app_path(app)?)?;
    connection
        .execute("DELETE FROM notes WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn migrate_json_store(dir: &Path) -> Result<(), String> {
    let legacy = dir.join("notes.json");
    if !legacy.is_file() {
        return Ok(());
    }
    let notes = read_store(&legacy);
    let connection = crate::storage::open(&dir.join("synapse.db"))?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if count == 0 {
        for note in &notes {
            insert_or_replace(&connection, note)?;
        }
    }
    std::fs::rename(&legacy, dir.join("notes.json.migrated")).map_err(|error| error.to_string())
}

/// Folds the single legacy `notepad.txt` into the store as the first note.
///
/// Ordering is load-bearing: notes.json is written first and only then is the
/// legacy file *renamed* — never deleted. A crash between the two re-runs the
/// migration on the next launch, which the content-equality guard makes a
/// no-op. Takes a `&Path` so it is testable without a Tauri runtime, same as
/// `settings::load`.
pub fn migrate_legacy(dir: &Path) -> Result<(), String> {
    let legacy = dir.join("notepad.txt");
    if !legacy.is_file() {
        return Ok(());
    }
    let Ok(text) = std::fs::read_to_string(&legacy) else {
        return Ok(());
    };

    let store = dir.join("notes.json");
    let mut notes = read_store(&store);
    if !text.trim().is_empty() && !notes.iter().any(|n| n.content == text) {
        notes.insert(
            0,
            Note {
                content: text,
                ..Default::default()
            },
        );
    }

    write_store(&store, &notes)?;
    let _ = std::fs::rename(&legacy, dir.join("notepad.txt.migrated"));
    Ok(())
}

/// Read/write an arbitrary path the user picked in a file dialog. Unlike the
/// store, a missing file is an error rather than an empty note — the dialog
/// only ever hands back a path that existed a moment ago, so "not found" here
/// means something is genuinely wrong and silently opening a blank buffer
/// would look like the file's contents were lost.
pub fn read_from(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

pub fn write_to(path: &str, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("{path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-notes-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn migrates_legacy_txt_into_the_first_note() {
        let dir = temp_dir("migrate");
        std::fs::write(dir.join("notepad.txt"), "shopping list\nmilk").expect("write legacy note");

        migrate_legacy(&dir).expect("migrate");

        let notes = read_store(&dir.join("notes.json"));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, "shopping list\nmilk");
        assert!(
            dir.join("notepad.txt.migrated").is_file(),
            "the legacy file is renamed, never deleted"
        );
        assert!(!dir.join("notepad.txt").exists());
    }

    /// Simulates a crash between writing notes.json and renaming the legacy
    /// file: the migration runs again next launch and must not duplicate.
    #[test]
    fn migration_is_idempotent() {
        let dir = temp_dir("migrate-twice");
        std::fs::write(dir.join("notepad.txt"), "only once").expect("write legacy note");

        migrate_legacy(&dir).expect("first");
        std::fs::write(dir.join("notepad.txt"), "only once").expect("restore legacy note");
        migrate_legacy(&dir).expect("second");

        assert_eq!(read_store(&dir.join("notes.json")).len(), 1);
    }

    #[test]
    fn migration_skips_an_empty_legacy_file() {
        let dir = temp_dir("migrate-empty");
        std::fs::write(dir.join("notepad.txt"), "   \n\n").expect("write legacy note");

        migrate_legacy(&dir).expect("migrate");

        assert!(read_store(&dir.join("notes.json")).is_empty());
    }

    #[test]
    fn migration_preserves_existing_notes() {
        let dir = temp_dir("migrate-existing");
        let existing = Note {
            content: "already here".into(),
            ..Default::default()
        };
        write_store(&dir.join("notes.json"), std::slice::from_ref(&existing)).expect("seed store");
        std::fs::write(dir.join("notepad.txt"), "from the old notepad").expect("write legacy");

        migrate_legacy(&dir).expect("migrate");

        let notes = read_store(&dir.join("notes.json"));
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].content, "from the old notepad", "the import lands first");
        assert_eq!(notes[1], existing, "the existing note is untouched");
    }

    #[test]
    fn title_uses_the_first_non_empty_line() {
        let note = Note {
            content: "\n\n  Real title  \nbody".into(),
            ..Default::default()
        };
        assert_eq!(note.title(), "Real title");
    }

    #[test]
    fn title_of_an_empty_note_is_a_placeholder_not_an_empty_string() {
        assert_eq!(Note::default().title(), "New note");
    }

    #[test]
    fn title_is_truncated_with_an_ellipsis() {
        let note = Note {
            content: "x".repeat(60),
            ..Default::default()
        };
        let title = note.title();
        assert_eq!(title.chars().count(), 41, "40 chars plus the ellipsis");
        assert!(title.ends_with('…'));
    }

    #[test]
    fn rich_document_update_rejects_a_stale_revision() {
        let mut note = Note::default();
        let first = update_document_checked(&mut note, r#"{"type":"doc","content":[]}"#.into(), "First".into(), 0)
            .expect("first update");
        assert_eq!(first, 1);

        let error = update_document_checked(&mut note, r#"{"type":"doc","content":[]}"#.into(), "Stale".into(), 0)
            .expect_err("stale writer must not overwrite newer text");
        assert!(error.contains("revision conflict"));
        assert_eq!(note.content, "First");
    }

    #[test]
    fn sqlite_revision_conversion_rejects_values_outside_sqlite_integer_range() {
        assert_eq!(sql_revision(7).expect("small revisions fit SQLite"), 7);
        assert!(
            sql_revision(u64::MAX).is_err(),
            "SQLite stores revisions as signed integers"
        );
    }

    #[test]
    fn older_plain_text_notes_gain_an_empty_rich_document() {
        let dir = temp_dir("legacy-rich-fields");
        let path = dir.join("notes.json");
        std::fs::write(&path, r#"[{"id":"abc","content":"Legacy body"}]"#).expect("write legacy store");

        let notes = read_store(&path);
        assert_eq!(notes[0].content, "Legacy body");
        assert!(notes[0].document.is_empty());
        assert_eq!(notes[0].revision, 0);
        assert!(!notes[0].favorite);
        assert!(notes[0].trashed_at.is_none());
    }

    #[test]
    fn migrates_the_json_note_store_into_sqlite_once() {
        let dir = temp_dir("json-to-sqlite");
        let legacy = Note {
            content: "Preserve me".into(),
            favorite: true,
            ..Default::default()
        };
        write_store(&dir.join("notes.json"), std::slice::from_ref(&legacy)).expect("seed json");

        migrate_json_store(&dir).expect("migrate json");

        let connection = crate::storage::open(&dir.join("synapse.db")).expect("open database");
        let stored: String = connection
            .query_row("SELECT plain_text FROM notes WHERE id = ?1", [&legacy.id], |row| {
                row.get(0)
            })
            .expect("migrated row");
        assert_eq!(stored, "Preserve me");
        assert!(dir.join("notes.json.migrated").is_file());
    }

    /// A notes.json from a future build (unknown fields) or an older one
    /// (missing fields) must still load rather than wiping the user's notes.
    #[test]
    fn store_tolerates_missing_and_unknown_fields() {
        let dir = temp_dir("compat");
        let path = dir.join("notes.json");
        std::fs::write(&path, r#"[{"id":"abc","content":"hi","sparkles":true}]"#).expect("write partial store");

        let notes = read_store(&path);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, "hi");
        assert_eq!(notes[0].color, "amber", "missing field takes its default");
        assert_eq!(notes[0].w, 320);
    }

    #[test]
    fn corrupt_store_is_backed_up_rather_than_silently_lost() {
        let dir = temp_dir("corrupt");
        let path = dir.join("notes.json");
        std::fs::write(&path, "{not json at all").expect("write corrupt store");

        assert!(read_store(&path).is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("notes.json.bak")).expect("backup exists"),
            "{not json at all"
        );
    }

    #[test]
    fn write_to_then_read_from_round_trips() {
        let path = temp_dir("round-trip").join("note.txt");
        let path = path.to_str().unwrap();

        write_to(path, "hello\nworld").unwrap();
        assert_eq!(read_from(path).unwrap(), "hello\nworld");

        // Saving again must replace, not append.
        write_to(path, "replaced").unwrap();
        assert_eq!(read_from(path).unwrap(), "replaced");
    }

    #[test]
    fn read_from_errors_on_a_missing_file_instead_of_returning_empty() {
        let path = temp_dir("missing").join("nope.txt");
        let err = read_from(path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("nope.txt"), "error should name the path: {err}");
    }
}
