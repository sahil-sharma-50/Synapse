use std::path::PathBuf;

/// Single persistent note — PRD §4.3: "same note every time, not a new note
/// per invocation." Plain text file rather than a database; debouncing the
/// autosave is the frontend's job (JS setTimeout), this is just read/write.
fn note_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("notepad.txt"))
}

pub fn read(app: &tauri::AppHandle) -> Result<String, String> {
    let path = note_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write(app: &tauri::AppHandle, content: &str) -> Result<(), String> {
    let path = note_path(app)?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Read/write an arbitrary path the user picked in a file dialog. Unlike
/// `read`, a missing file is an error rather than an empty note — the dialog
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
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
        assert!(
            err.contains("nope.txt"),
            "error should name the path: {err}"
        );
    }
}
