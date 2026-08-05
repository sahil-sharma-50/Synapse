use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// How long after our own last clipboard write to keep ignoring changes.
///
/// `paste_text` writes twice — the injected text, then the user's previous
/// contents restored — and Windows reports the resulting sequence-number bump
/// asynchronously, so the restore can become observable *after* the function
/// has already returned. This window must exceed one watcher poll (400 ms) or
/// the poll that sees the restore would record it as if the user had copied it.
const SUPPRESS_TAIL_MS: u64 = 600;

/// Nesting depth of clipboard operations Synapse is performing on its own.
///
/// A counter, not a bool: `copy_selection` and `paste_text` nest (the
/// speak-selected path runs one inside the other), and a bool would be cleared
/// by the inner guard while the outer one was still mid-write.
static SELF_OPS: AtomicUsize = AtomicUsize::new(0);
static SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SELF_WRITE: Mutex<Option<String>> = Mutex::new(None);

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Marks a region in which Synapse itself is writing to the clipboard, so the
/// history watcher doesn't record our own writes as things the user copied.
/// Without it, every dictation and every paste would log both the injected text
/// and the user's prior clipboard contents.
pub struct ClipboardGuard;

impl ClipboardGuard {
    pub fn new() -> Self {
        SELF_OPS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        SUPPRESS_UNTIL_MS.store(now_ms() + SUPPRESS_TAIL_MS, Ordering::SeqCst);
        SELF_OPS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// True while Synapse is (or has just been) writing to the clipboard itself.
pub fn is_suppressed() -> bool {
    SELF_OPS.load(Ordering::SeqCst) > 0 || now_ms() < SUPPRESS_UNTIL_MS.load(Ordering::SeqCst)
}

fn note_self_write(text: &str) {
    if let Ok(mut last) = LAST_SELF_WRITE.lock() {
        *last = Some(text.to_string());
    }
}

/// Content backstop, for a watcher poll landing after even the time window has
/// closed. Not sufficient on its own: `paste_text`'s restore write puts back
/// the user's *previous* clipboard, which is not the text we injected.
pub fn matches_self_write(text: &str) -> bool {
    LAST_SELF_WRITE
        .lock()
        .map(|last| last.as_deref() == Some(text))
        .unwrap_or(false)
}

/// Saves the clipboard, writes `text`, synthesizes a paste keystroke into
/// whatever field currently has OS focus, then restores the original
/// clipboard contents (PRD §4.4). Caller is responsible for making sure the
/// intended target window already has focus before calling this.
pub fn paste_text(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    let _guard = ClipboardGuard::new();
    let clipboard = app.clipboard();
    let previous = clipboard.read_text().ok();

    note_self_write(text);
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
        note_self_write(&prev);
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
    let _guard = ClipboardGuard::new();
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
        note_self_write(&prev);
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

    /// The statics are process-global, so these three run as one test rather
    /// than racing each other through the shared counter.
    #[test]
    fn clipboard_guard_suppresses_while_held_nested_and_briefly_after() {
        assert!(!is_suppressed(), "no suppression before any guard exists");

        let outer = ClipboardGuard::new();
        assert!(is_suppressed());

        {
            let _inner = ClipboardGuard::new();
            assert!(is_suppressed());
        }
        // The nested guard dropping must NOT clear suppression — this is the
        // whole reason SELF_OPS is a counter rather than a bool.
        assert!(
            SELF_OPS.load(Ordering::SeqCst) > 0,
            "outer guard still holds the count after the inner one drops"
        );

        drop(outer);
        // Still suppressed: the OS reports our last write asynchronously.
        assert!(is_suppressed(), "suppression outlives the guard by SUPPRESS_TAIL_MS");
        assert!(SELF_OPS.load(Ordering::SeqCst) == 0, "count unwound cleanly");
    }

    #[test]
    fn self_write_content_is_recognised() {
        note_self_write("injected text");
        assert!(matches_self_write("injected text"));
        assert!(!matches_self_write("something the user copied"));
    }
}
