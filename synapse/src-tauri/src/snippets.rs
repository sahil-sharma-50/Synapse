use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Local JSON store (PRD §6.4). Full create/edit/delete management belongs
/// in Settings (M5) — the picker here supports search/insert plus a minimal
/// inline "add" so snippets are actually usable before Settings exists.
#[derive(Serialize, Deserialize, Clone)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub content: String,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("snippets.json"))
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<Snippet>, String> {
    let path = store_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(app: &tauri::AppHandle, snippets: &[Snippet]) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(snippets).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn add(app: &tauri::AppHandle, name: String, content: String) -> Result<Snippet, String> {
    let mut snippets = list(app)?;
    let snippet = Snippet {
        id: uuid_v4(),
        name,
        content,
    };
    snippets.push(snippet.clone());
    save(app, &snippets)?;
    Ok(snippet)
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let mut snippets = list(app)?;
    snippets.retain(|s| s.id != id);
    save(app, &snippets)
}

/// Good enough for a locally-generated id — avoids pulling in the `uuid`
/// crate for one call site.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
