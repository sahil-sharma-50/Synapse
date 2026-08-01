use std::path::PathBuf;
use tauri_plugin_clipboard_manager::ClipboardExt;
use xcap::Monitor;

/// Default save location: ~/Pictures/Synapse (configurable in Settings — M5).
fn save_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir().ok_or("could not find a Pictures directory")?;
    let dir = base.join("Synapse");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Captures the monitor the cursor is currently on (falling back to the
/// primary monitor if cursor position isn't available), saves it to disk,
/// and copies it to the clipboard — both per PRD §4.3.
pub fn capture(app: &tauri::AppHandle, cursor: Option<(i32, i32)>) -> Result<PathBuf, String> {
    let monitor = match cursor.and_then(|(x, y)| Monitor::from_point(x, y).ok()) {
        Some(m) => m,
        None => Monitor::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .ok_or("no monitor found")?,
    };

    // xcap::Image is image::RgbaImage — .save() borrows, so grab dimensions
    // and save before consuming it with into_raw() for the clipboard copy.
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let (width, height) = (image.width(), image.height());

    let dir = save_dir()?;
    let filename = format!("synapse-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(&filename);
    image.save(&path).map_err(|e| e.to_string())?;

    let rgba = image.into_raw();
    let clipboard_image = tauri::image::Image::new(&rgba, width, height);
    if let Err(e) = app.clipboard().write_image(&clipboard_image) {
        eprintln!("[synapse] screenshot saved but clipboard copy failed: {e}");
    }

    Ok(path)
}
