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

/// Pure decision logic behind `copy_selection`, split out so it's testable
/// without a live clipboard/enigo: `None` means "treat this as no selection"
/// (nothing new was copied), `Some` is the text to speak.
fn resolve_selection(previous: Option<String>, captured: Option<String>) -> Option<String> {
    match captured {
        Some(text) if !text.is_empty() && Some(&text) != previous.as_ref() => Some(text),
        _ => None,
    }
}

/// Simulates Ctrl+C to capture whatever text is currently selected in the
/// foreground window, then restores the clipboard to what it held before —
/// same capture-then-restore spirit as `paste_text`'s clipboard restore.
/// Caller is responsible for making sure the intended source window already
/// has focus before calling this (mirrors `paste_text`'s contract).
pub fn copy_selection(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let clipboard = app.clipboard();
    let previous = clipboard.read_text().ok();

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("{e:?}"))?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| format!("{e:?}"))?;
    enigo.key(Key::Unicode('c'), Direction::Click).map_err(|e| format!("{e:?}"))?;
    enigo.key(modifier, Direction::Release).map_err(|e| format!("{e:?}"))?;

    std::thread::sleep(std::time::Duration::from_millis(80));

    let captured = clipboard.read_text().ok();
    let result = resolve_selection(previous.clone(), captured);

    if let Some(prev) = previous {
        let _ = clipboard.write_text(prev);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_result_is_none_when_clipboard_unchanged() {
        let previous = Some("hello".to_string());
        let captured = Some("hello".to_string());
        assert_eq!(resolve_selection(previous, captured), None);
    }

    #[test]
    fn selection_result_is_none_when_captured_is_empty() {
        let previous = Some("hello".to_string());
        let captured = Some(String::new());
        assert_eq!(resolve_selection(previous, captured), None);
    }

    #[test]
    fn selection_result_is_some_when_clipboard_changed() {
        let previous = Some("hello".to_string());
        let captured = Some("world".to_string());
        assert_eq!(resolve_selection(previous, captured), Some("world".to_string()));
    }

    #[test]
    fn selection_result_is_some_when_clipboard_was_previously_empty() {
        let previous = None;
        let captured = Some("world".to_string());
        assert_eq!(resolve_selection(previous, captured), Some("world".to_string()));
    }
}
