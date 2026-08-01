use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Saves the clipboard, writes `text`, synthesizes a paste keystroke into
/// whatever field currently has OS focus, then restores the original
/// clipboard contents (PRD §4.4). Caller is responsible for making sure the
/// intended target window already has focus before calling this.
pub fn paste_text(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    let clipboard = app.clipboard();
    let previous = clipboard.read_text().ok();

    clipboard.write_text(text.to_string()).map_err(|e| e.to_string())?;
    // Give the target window a moment to actually be focused/ready before
    // synthesizing input into it.
    std::thread::sleep(std::time::Duration::from_millis(80));

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("{e:?}"))?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| format!("{e:?}"))?;
    enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| format!("{e:?}"))?;
    enigo.key(modifier, Direction::Release).map_err(|e| format!("{e:?}"))?;

    std::thread::sleep(std::time::Duration::from_millis(80));
    if let Some(prev) = previous {
        let _ = clipboard.write_text(prev);
    }

    Ok(())
}
