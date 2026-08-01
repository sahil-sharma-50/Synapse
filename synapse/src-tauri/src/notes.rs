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
