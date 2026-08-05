mod ai;
mod asr;
mod clipboard_history;
mod ids;
mod inject;
mod model_download;
mod notes;
mod screenshot;
mod sentences;
mod settings;
mod tts;
mod tts_pocket;
mod tts_setup;
mod updater;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const OVERLAY_LABEL: &str = "overlay";
/// The notes list. Individual sticky notes are separate windows labelled
/// `note-<id>`; note that "notes-hub" deliberately does NOT start with "note-"
/// (it's "notes-", with the s), so the frontend's prefix routing and the
/// `note-*` capability glob can't accidentally match it. One character apart.
const NOTES_HUB_LABEL: &str = "notes-hub";
const NOTE_LABEL_PREFIX: &str = "note-";
/// Renamed from "snippet-picker" when the feature became a real clipboard
/// history. The label appears in capabilities/default.json's window allowlist —
/// changing one without the other silently kills all IPC in this window.
const CLIPBOARD_LABEL: &str = "clipboard";
const AI_LABEL: &str = "ai-panel";
const SETTINGS_LABEL: &str = "settings";
const ONBOARDING_LABEL: &str = "onboarding";
/// Written by the NSIS post-install hook (see `installer/hooks.nsh`), consumed
/// on the next launch. Lives in the app data dir alongside settings.json.
const FRESH_INSTALL_MARKER: &str = ".fresh-install";
// Window is intentionally larger than the wheel itself (wheel diameter 300 in
// App.tsx): the extra margin gives the CSS drop-shadow room to fade out inside
// the window. Without it the shadow clips at the window edge and reads as a
// visible rectangle around the circle.
const OVERLAY_SIZE: f64 = 360.0;

/// The HWND (as isize) of whatever app was focused right before the overlay
/// was summoned. Restored just before any text injection (M2+) so dictated
/// or snippet text lands in the field the user was actually in, and restored
/// on dismiss so the underlying app's focus is exactly as the user left it.
///
/// This replaces an earlier WS_EX_NOACTIVATE + WM_MOUSEACTIVATE-subclass
/// approach that tried to make the overlay never take focus at all: that
/// approach broke mouse clicks entirely (Windows silently swallowed them,
/// and the subclass never even saw WM_NCHITTEST — evidence that Tauri/WRY's
/// own window setup re-subclasses the wndproc after ours ran). Letting the
/// overlay activate normally and restoring focus afterward is the standard
/// pattern most Windows overlay/launcher tools use, and it's far more
/// robust: clicks and Esc work out of the box.
#[cfg(target_os = "windows")]
static PREVIOUS_FOCUS: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

#[cfg(target_os = "windows")]
fn cursor_position() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }
    (pt.x, pt.y)
}

#[cfg(target_os = "windows")]
fn capture_previous_focus() {
    use std::sync::atomic::Ordering;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        PREVIOUS_FOCUS.store(hwnd.0 as isize, Ordering::SeqCst);
    }
}

/// Restores focus to whatever app was focused before the overlay was shown.
/// Call this before injecting text (M2+ Speech-to-Text/Snippet/AI insert)
/// and when the overlay is dismissed.
#[cfg(target_os = "windows")]
pub fn restore_previous_focus() {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let raw = PREVIOUS_FOCUS.load(Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let _ = SetForegroundWindow(HWND(raw as *mut _));
        }
    }
}

// NOTE: the window is deliberately left rectangular and transparent, with the
// circle drawn in SVG by the frontend. An earlier version clipped the HWND with
// SetWindowRgn(CreateEllipticRgn(..)), but GDI regions have hard, un-antialiased
// edges, which made the rim look faceted rather than round. Clicks landing on the
// transparent corners hit the overlay root, which dismisses — the desired
// behavior anyway, so nothing is lost by not clipping.

fn show_overlay_at_cursor(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    #[cfg(target_os = "windows")]
    capture_previous_focus();

    #[cfg(target_os = "windows")]
    {
        let (x, y) = cursor_position();
        let half = (OVERLAY_SIZE / 2.0) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(x - half, y - half));
    }

    let _ = window.show();
    let _ = window.set_focus();
}

fn hide_overlay(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
    }
    #[cfg(target_os = "windows")]
    restore_previous_focus();
}

#[tauri::command]
fn dismiss_overlay(app: tauri::AppHandle) {
    hide_overlay(&app);
}

#[tauri::command]
fn force_quit(app: tauri::AppHandle) {
    println!("[synapse] force quit requested from wheel");
    app.exit(0);
}

#[tauri::command]
fn select_wedge(app: tauri::AppHandle, wedge: String) {
    println!("[synapse] wedge selected: {wedge}");
    match wedge.as_str() {
        "screenshot" => {
            #[cfg(target_os = "windows")]
            let cursor = Some(cursor_position());
            #[cfg(not(target_os = "windows"))]
            let cursor = None;

            hide_overlay(&app);
            // hide_overlay returns before the compositor has actually removed
            // the window, so capturing immediately catches the wheel in the
            // shot. Wait a beat, on a background thread so the UI stays live.
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(180));
                let toast = match screenshot::capture(&app, cursor) {
                    Ok(path) => {
                        println!("[synapse] screenshot saved to {}", path.display());
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        Toast {
                            title: "Screenshot saved".into(),
                            detail: format!("Pictures\\Synapse\\{name}"),
                            path: Some(path.to_string_lossy().to_string()),
                            tone: ToastTone::Ok,
                        }
                    }
                    Err(e) => {
                        eprintln!("[synapse] screenshot failed: {e}");
                        Toast::error("Screenshot failed", e)
                    }
                };
                show_toast(&app, toast);
            });
        }
        "notepad" => {
            hide_overlay(&app);
            show_utility_window(&app, NOTES_HUB_LABEL);
        }
        "clipboard" => {
            hide_overlay(&app);
            show_utility_window(&app, CLIPBOARD_LABEL);
        }
        "ai" => {
            hide_overlay(&app);
            show_utility_window(&app, AI_LABEL);
        }
        "settings" => {
            hide_overlay(&app);
            show_utility_window(&app, SETTINGS_LABEL);
        }
        "speak-selected" => {
            hide_overlay(&app);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(180));
                #[cfg(target_os = "windows")]
                restore_previous_focus();
                std::thread::sleep(std::time::Duration::from_millis(80));

                match inject::copy_selection(&app) {
                    Ok(Some(text)) => {
                        speak_text(app.clone(), text);
                    }
                    Ok(None) => show_toast(
                        &app,
                        Toast::error("Nothing selected", "Select some text first, then try again"),
                    ),
                    Err(e) => {
                        eprintln!("[synapse] selection capture failed: {e}");
                        show_toast(
                            &app,
                            Toast::error("Couldn't read the selection", "Try copying it manually"),
                        );
                    }
                }
            });
        }
        other => {
            println!("[synapse] no handler yet for wedge: {other}");
            hide_overlay(&app);
        }
    }
}

/// Briefly re-shows the overlay as a confirmation message, so actions that
/// otherwise happen invisibly (screenshot) give the user feedback that they
/// actually fired. Blocking — call from a background thread.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum ToastTone {
    Ok,
    Error,
}

/// A toast used to be a single `\n`-joined string the frontend split apart.
/// It carries a file path now (so the screenshot toast can reveal what it just
/// saved) and a tone, neither of which survives string-splitting.
#[derive(Clone, serde::Serialize)]
struct Toast {
    title: String,
    detail: String,
    path: Option<String>,
    tone: ToastTone,
}

impl Toast {
    fn error(title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            detail: detail.into(),
            path: None,
            tone: ToastTone::Error,
        }
    }
}

/// Opens the folder containing `path` with the file selected. Called from the
/// screenshot toast, which names a file the user may well want to go look at.
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) {
    use tauri_plugin_opener::OpenerExt;
    // Called through the plugin's Rust API rather than its JS command, so the
    // narrow `opener:allow-open-url` allowlist in capabilities/default.json
    // (deliberately ms-settings: only) doesn't need widening to every path.
    if let Err(e) = app.opener().reveal_item_in_dir(&path) {
        eprintln!("[synapse] could not reveal {path}: {e}");
    }
}

fn show_toast(app: &tauri::AppHandle, message: Toast) {
    /// The old 1500 ms was long enough to notice a flash and too short to read
    /// where the file went, which is the entire content of the message. Long
    /// enough to read a path, short enough not to feel stuck.
    const TOAST_DWELL_MS: u64 = 3400;

    let _ = app.emit("toast", message);
    // Let the webview render the toast state before the window is shown,
    // otherwise the wheel flashes for a frame first.
    std::thread::sleep(std::time::Duration::from_millis(60));
    show_overlay_at_cursor(app);

    // Poll rather than sleeping the whole dwell in one go: the toast is
    // click- and Esc-dismissible, and once the user has dismissed it this
    // thread must stop owning the window — otherwise it would sit here for
    // seconds and then "helpfully" hide a wheel the user had since reopened.
    let window = app.get_webview_window(OVERLAY_LABEL);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(TOAST_DWELL_MS);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(80));
        if let Some(w) = &window {
            if !w.is_visible().unwrap_or(true) {
                return; // dismissed early; whoever hid it also restored focus
            }
        }
    }
    hide_overlay(app);
}

/// Starts an OS-native window drag of the overlay, so the wheel can be moved
/// by its centre hub.
///
/// Driven from Rust rather than the webview's own `startDragging()` for one
/// reason: `invoke` is asynchronous, so on a fast click-and-flick the drag
/// request can arrive *after* the mouse button is already up. Windows then
/// enters a modal move loop with no button held and the window follows the
/// cursor until the next click — a genuinely stuck state. Re-checking the
/// physical button here, immediately before handing off to the OS, closes
/// that window.
#[tauri::command]
fn start_overlay_drag(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        // High bit set == currently down.
        let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
        if !down {
            return;
        }
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.start_dragging();
    }
}

/// Failures here are reported rather than swallowed: a window that silently
/// refuses to appear is indistinguishable from a dead click, and tracking one
/// down through a `let _ =` cost a full debug cycle once already.
/// Shows a window and forces it to the front of the Z-order.
///
/// `WebviewWindowBuilder::visible(true)` isn't enough for the one launch that
/// matters most: the installer's "Run Synapse" finish-page checkbox starts the
/// app while the installer still owns the foreground, and Windows' foreground
/// lock then refuses the new process activation — the wizard opens *behind* the
/// installer (and behind whatever else is open) and reads as "nothing happened".
///
/// Bouncing through always-on-top is what fixes that: it moves the window with
/// SetWindowPos, which is pure Z-order and isn't gated by the foreground lock,
/// and dropping topmost again leaves the window at the top of the normal band
/// rather than permanently floating over the user's other apps. So the window is
/// on top whether or not `set_focus`'s SetForegroundWindow is honoured.
fn show_foreground(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let _ = window.set_always_on_top(false);
}

/// True exactly once after the installer has run.
///
/// Split from the `AppHandle` lookup so it's testable without a Tauri runtime,
/// same as `settings::load`. `remove_file` both answers "was it there?" and
/// clears it, so onboarding shows on the first launch after an install and not
/// on every launch after that.
fn take_fresh_install_marker(dir: &std::path::Path) -> bool {
    std::fs::remove_file(dir.join(FRESH_INSTALL_MARKER)).is_ok()
}

fn show_utility_window(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        eprintln!(
            "[synapse] show_utility_window({label}): no such window (have: {:?})",
            app.webview_windows().keys().collect::<Vec<_>>()
        );
        return;
    };
    if let Err(e) = window.show() {
        eprintln!("[synapse] show_utility_window({label}): show failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        eprintln!("[synapse] show_utility_window({label}): set_focus failed: {e}");
    }
}

fn note_label(id: &str) -> String {
    format!("{NOTE_LABEL_PREFIX}{id}")
}

/// Pending note geometry, flushed on a timer. `Moved` fires once per pixel
/// during a drag, so writing notes.json on every event would hammer the disk;
/// one shared map plus one flush thread avoids both that and a thread per note.
#[derive(Default)]
struct GeometryQueue(std::sync::Mutex<std::collections::HashMap<String, (i32, i32, u32, u32)>>);

fn queue_geometry(app: &tauri::AppHandle, id: &str, window: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    // Read the window rather than trusting the event payload, so a Moved and a
    // Resized event each yield a complete tuple.
    if let Ok(mut pending) = app.state::<GeometryQueue>().0.lock() {
        pending.insert(id.to_string(), (pos.x, pos.y, size.width, size.height));
    }
}

fn flush_geometry(app: &tauri::AppHandle) {
    let pending: Vec<(String, (i32, i32, u32, u32))> = {
        let state = app.state::<GeometryQueue>();
        let Ok(mut map) = state.0.lock() else { return };
        map.drain().collect()
    };
    for (id, (x, y, w, h)) in pending {
        if let Err(e) = notes::update_geometry(app, &id, x, y, w, h) {
            eprintln!("[synapse] could not save note geometry: {e}");
        }
    }
}

/// Keeps a note on a monitor that actually exists. A note last saved on a
/// second display that has since been unplugged would otherwise reopen at
/// coordinates nothing can reach, and be permanently invisible.
fn position_is_visible(app: &tauri::AppHandle, x: i32, y: i32) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        // Require a decent slice of the title bar to be on-screen, not just the
        // last pixel of a corner.
        x + 80 >= p.x && x <= p.x + s.width as i32 - 40 && y >= p.y && y <= p.y + s.height as i32 - 40
    })
}

/// Opens (or focuses) the window for one note.
///
/// Note windows are DESTROYED on close rather than hidden — the one deliberate
/// exception to this codebase's "utility windows hide, they don't close" rule.
/// That rule exists because `show()` on a destroyed window is a silent no-op,
/// which only matters for windows summoned by a *fixed* label. Notes are
/// rebuilt by label on demand and there are N of them, so hiding would leak a
/// live webview for every note ever opened. The `get_webview_window` guard
/// below is what makes destroy-and-rebuild safe: Tauri panics on a duplicate
/// window label.
#[tauri::command]
fn open_note_window(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let label = note_label(&id);
    if let Some(existing) = app.get_webview_window(&label) {
        show_foreground(&existing);
        return Ok(());
    }

    let note = notes::get(&app, &id)?;
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(note.title())
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .min_inner_size(220.0, 160.0)
        // Built hidden so the saved geometry is applied before the first paint,
        // rather than the note visibly jumping from the default position.
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.set_size(tauri::PhysicalSize::new(note.w, note.h));
    match (note.x, note.y) {
        (Some(x), Some(y)) if position_is_visible(&app, x, y) => {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = window.center();
        }
    }

    notes::set_open(&app, &id, true)?;

    let ev_app = app.clone();
    let ev_window = window.clone();
    let ev_id = id.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            queue_geometry(&ev_app, &ev_id, &ev_window);
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            // No prevent_close: see the doc comment above. Flush first, because
            // after this the webview is gone and its pending debounce with it.
            queue_geometry(&ev_app, &ev_id, &ev_window);
            flush_geometry(&ev_app);
            let _ = notes::set_open(&ev_app, &ev_id, false);
            let _ = ev_app.emit("notes-changed", ());
        }
        _ => {}
    });

    show_foreground(&window);
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn list_notes(app: tauri::AppHandle) -> Result<Vec<NoteSummary>, String> {
    Ok(notes::list(&app)?
        .into_iter()
        .map(|n| NoteSummary {
            title: n.title(),
            preview: n
                .content
                .lines()
                .skip_while(|l| l.trim().is_empty())
                .skip(1)
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .chars()
                .take(60)
                .collect(),
            id: n.id,
            color: n.color,
            open: n.open,
            updated_at: n.updated_at,
        })
        .collect())
}

/// The hub only needs a title and a preview, and the notes could collectively
/// be megabytes of text — no reason to ship all of it to the list window.
#[derive(serde::Serialize)]
struct NoteSummary {
    id: String,
    title: String,
    preview: String,
    color: String,
    open: bool,
    updated_at: i64,
}

/// Write to an explicit path the user picked in a file dialog, rather than to
/// the notes store that `save_note_content` owns. A sticky note linked to a
/// file writes to *both*: the store is the note's identity and must stay
/// authoritative, the file is an export that tracks it.
#[tauri::command]
fn save_note_to(content: String, path: String) -> Result<(), String> {
    notes::write_to(&path, &content)
}

#[tauri::command]
fn load_note_from(path: String) -> Result<String, String> {
    notes::read_from(&path)
}

#[tauri::command]
fn get_note(app: tauri::AppHandle, id: String) -> Result<notes::Note, String> {
    notes::get(&app, &id)
}

#[tauri::command]
fn create_note(app: tauri::AppHandle, color: Option<String>) -> Result<String, String> {
    let note = notes::create(&app, color)?;
    open_note_window(app, note.id.clone())?;
    Ok(note.id)
}

#[tauri::command]
fn save_note_content(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    notes::update_content(&app, &id, content)?;
    // Keeps the undecorated window's own title (used in the taskbar/alt-tab)
    // and the hub list in step with the first line as it's typed.
    if let Some(window) = app.get_webview_window(&note_label(&id)) {
        if let Ok(note) = notes::get(&app, &id) {
            let _ = window.set_title(&note.title());
        }
    }
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn set_note_color(app: tauri::AppHandle, id: String, color: String) -> Result<(), String> {
    notes::update_color(&app, &id, color)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn close_note_window(app: tauri::AppHandle, id: String) {
    // Routed through Rust rather than the webview closing itself, so the flush
    // and the `open: false` write happen in a defined order before teardown.
    if let Some(window) = app.get_webview_window(&note_label(&id)) {
        let _ = window.close();
    }
}

#[tauri::command]
fn delete_note(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&note_label(&id)) {
        let _ = window.destroy();
    }
    // Drop any queued geometry first, or the flush thread would resurrect a
    // row for the note we just deleted.
    if let Ok(mut pending) = app.state::<GeometryQueue>().0.lock() {
        pending.remove(&id);
    }
    notes::delete(&app, &id)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn list_clipboard(app: tauri::AppHandle) -> Result<Vec<clipboard_history::ClipEntry>, String> {
    clipboard_history::list(&app)
}

#[tauri::command]
fn pin_clipboard_entry(app: tauri::AppHandle, id: String, pinned: bool) -> Result<(), String> {
    clipboard_history::set_pinned(&app, &id, pinned)
}

#[tauri::command]
fn delete_clipboard_entry(app: tauri::AppHandle, id: String) -> Result<(), String> {
    clipboard_history::delete(&app, &id)
}

/// Clears auto-captured history only. Pinned entries were saved deliberately,
/// so a "clear history" that also destroyed them would be a nasty surprise.
#[tauri::command]
fn clear_clipboard_history(app: tauri::AppHandle) -> Result<(), String> {
    clipboard_history::clear_history(&app)
}

#[tauri::command]
fn add_pinned_clip(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<clipboard_history::ClipEntry, String> {
    clipboard_history::add_pinned(&app, name, content)
}

/// Restores focus to the app the user was in before the wheel/picker opened
/// (captured back when the overlay was first shown) and pastes the entry
/// there — same clipboard paste-and-restore path as dictation (PRD §4.4).
/// Routing through `inject::paste_text` means the history watcher suppresses
/// this write for free rather than logging it back as a fresh copy.
#[tauri::command]
fn insert_clip(app: tauri::AppHandle, content: String) {
    if let Some(window) = app.get_webview_window(CLIPBOARD_LABEL) {
        let _ = window.hide();
    }

    // Runs off-thread: hiding a window is asynchronous, so restoring focus
    // and pasting immediately can land the text back in the picker's own
    // search box instead of the user's app.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        #[cfg(target_os = "windows")]
        restore_previous_focus();
        if let Err(e) = inject::paste_text(&app, &content) {
            eprintln!("[synapse] clipboard paste failed: {e}");
        }
    });
}

/// Records, transcribes, and pastes on a background thread so the UI/event-
/// loop thread never blocks on microphone I/O or model inference. The wheel
/// stays visible (in "listening" mode, driven by the `dictation-listening`
/// event the caller emits beforehand) until this finishes, so the user has
/// something to look at while recording instead of the wheel just vanishing.
/// Live recording state, pushed to the overlay ~20x/second. Without this the
/// listening circle is a static animation that looks identical whether the
/// microphone is working or not — tolerable when recording auto-stopped after
/// 900 ms of silence, unacceptable now that it runs until the user says stop.
#[derive(Clone, serde::Serialize)]
struct DictationTick {
    level: f32,
    elapsed_ms: u64,
    heard_speech: bool,
}

/// Whether dictation should end itself on trailing silence. Off by default —
/// see `settings::VoiceSettings`.
fn auto_stop_enabled(app: &tauri::AppHandle) -> bool {
    settings_path(app)
        .map(|p| settings::load(&p).voice.auto_stop_on_silence)
        .unwrap_or(false)
}

fn spawn_recording(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        println!("[synapse] dictation: recording started");

        // Failures surface in the overlay for a moment rather than the wheel
        // just silently vanishing, which is indistinguishable from a crash.
        let fail = |msg: String| {
            eprintln!("[synapse] dictation failed: {msg}");
            let _ = app.emit("dictation-error", msg);
            std::thread::sleep(std::time::Duration::from_millis(2600));
            hide_overlay(&app);
        };

        let auto_stop = auto_stop_enabled(&app);
        let tick_app = app.clone();
        let on_tick = move |t: asr::Tick| {
            let _ = tick_app.emit(
                "dictation-tick",
                DictationTick {
                    level: t.level,
                    elapsed_ms: t.elapsed_ms,
                    heard_speech: t.heard_speech,
                },
            );
        };

        match asr::record_and_transcribe(auto_stop, on_tick) {
            Ok(text) if !text.trim().is_empty() => {
                println!("[synapse] dictation: transcribed \"{text}\"");
                hide_overlay(&app);
                if let Err(e) = inject::paste_text(&app, &text) {
                    eprintln!("[synapse] paste failed: {e}");
                }
            }
            Ok(_) => fail("didn't catch anything - try speaking a bit louder".into()),
            Err(e) => fail(e),
        }
    });
}

#[tauri::command]
fn stop_dictation() {
    asr::request_stop();
}

/// Broadcasts `settings-changed` (even though settings.json itself didn't
/// change) so any open AI panel re-checks `provider_status` and clears its
/// "No API key set" state without waiting for a relaunch or an unrelated
/// settings save (see `update_settings` for the same pattern).
fn emit_settings_changed(app: &tauri::AppHandle) {
    if let Ok(path) = settings_path(app) {
        let _ = app.emit("settings-changed", settings::load(&path));
    }
}

#[tauri::command]
fn set_api_key(app: tauri::AppHandle, provider: String, key: String) -> Result<(), String> {
    ai::set_api_key(ai::Provider::from_str(&provider)?, &key)?;
    emit_settings_changed(&app);
    Ok(())
}

#[tauri::command]
fn provider_status() -> std::collections::HashMap<&'static str, bool> {
    let mut status = std::collections::HashMap::new();
    status.insert("anthropic", ai::has_api_key(ai::Provider::Anthropic));
    status.insert("openai", ai::has_api_key(ai::Provider::Openai));
    status
}

/// settings.json lives in the same app-data dir as notes.json and clipboard.json.
fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<settings::Settings, String> {
    Ok(settings::load(&settings_path(&app)?))
}

/// Writes the file, then broadcasts the new settings to every window. The AI
/// panel is only ever hidden, never closed, so it can't be relied on to re-read
/// config the next time it's shown — it has to be told.
#[tauri::command]
fn update_settings(app: tauri::AppHandle, settings: settings::Settings) -> Result<(), String> {
    settings::save(&settings_path(&app)?, &settings)?;
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

/// Shows the settings window, optionally jumping to a section. Both entry points
/// (the wheel wedge and the AI panel's deep-link) funnel through here so they
/// can't drift apart; the wedge passes `None` and leaves the last-selected
/// section in place.
#[tauri::command]
fn open_settings(app: tauri::AppHandle, section: Option<String>) {
    show_utility_window(&app, SETTINGS_LABEL);
    if let Some(section) = section {
        let _ = app.emit("settings-navigate", section);
    }
}

/// Required once Settings owns key management: with no inline form to overwrite
/// a key, "remove" is the only way to clear one.
#[tauri::command]
fn delete_api_key(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    ai::delete_api_key(ai::Provider::from_str(&provider)?)?;
    emit_settings_changed(&app);
    Ok(())
}

#[tauri::command]
fn model_status(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(model_download::is_downloaded(&model_download::model_dir(&app)?))
}

/// Reloading the ASR model after a successful download means dictation works
/// immediately without an app restart, even if the user downloaded from
/// Settings > Voice rather than during onboarding.
#[tauri::command]
fn download_model(app: tauri::AppHandle) -> Result<(), String> {
    let dir = model_download::model_dir(&app)?;
    // If the model is already fully present, this is a "Re-download" click,
    // not a first-time download. `download_one_file`/`spawn_download` both
    // treat an existing final file as already-done and skip it, so without
    // this the button would be a silent no-op. Deleting the files first
    // forces the real download logic (and its progress events) to run.
    if model_download::is_downloaded(&dir) {
        for file in model_download::MODEL_FILES {
            let _ = std::fs::remove_file(dir.join(file));
        }
    }
    model_download::spawn_download(app, move || asr::preload_model(dir));
    Ok(())
}

#[tauri::command]
fn tts_setup_status(app: tauri::AppHandle) -> bool {
    tts_setup::is_ready(&app)
}

#[tauri::command]
fn download_tts_engine(app: tauri::AppHandle) {
    tts_setup::spawn_setup(app);
}

/// Checks GitHub for a newer release than the running version. Runs the HTTP
/// call off the main thread (async command + spawn_blocking) so clicking
/// "Check for updates" never freezes the UI — same never-block-the-main-
/// thread precedent as `speak_text`/`send_ai_message`.
#[tauri::command]
async fn check_for_update() -> Result<updater::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let client = reqwest::blocking::Client::new();
        updater::check_for_update(
            &client,
            "https://api.github.com/repos",
            updater::REPO,
            env!("CARGO_PKG_VERSION"),
        )
    })
    .await
    .map_err(|e| format!("update check failed: {e}"))?
}

/// Starts a background download of the new installer. Progress/success/failure
/// come back over `update-download-progress`/`update-download-done`/
/// `update-download-error` events, not a return value — same pattern as
/// `download_model`.
#[tauri::command]
fn download_update(app: tauri::AppHandle, url: String, size: u64) {
    updater::spawn_update_download(app, url, size);
}

/// Launches the downloaded installer silently (`/S`) and exits the app so the
/// install can proceed without a live process holding files. Fails loudly if
/// there's nothing downloaded yet.
#[tauri::command]
fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    updater::launch_installer(app)
}

/// Resolves provider and model itself from settings rather than trusting a
/// frontend-supplied provider: the AI panel may invoke this before its own
/// `get_settings` call has resolved, and a missing/undefined argument would
/// fail Tauri's argument deserialization before this function body ever runs
/// — leaving `streaming` stuck `true` client-side with no `ai-done`/`ai-error`
/// event to clear it. Resolving server-side eliminates that case entirely.
///
/// `speak` is an explicit argument rather than something the backend infers,
/// because it is a per-conversation UI toggle. NOTE: adding it changed this
/// command's signature — `AiPanel.tsx` is the only call site and had to change
/// in the same commit, or Tauri's argument deserialization fails before this
/// body runs, which is exactly the stuck-`streaming` failure described above.
#[tauri::command]
fn send_ai_message(app: tauri::AppHandle, prompt: String, speak: bool) {
    std::thread::spawn(move || {
        let path = match settings_path(&app) {
            Ok(path) => path,
            Err(e) => {
                let _ = app.emit("ai-error", e);
                return;
            }
        };
        let ai_settings = settings::load(&path).ai;
        let provider = match ai::Provider::from_str(&ai_settings.provider) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit("ai-error", e);
                return;
            }
        };
        let model = ai_settings.model_for(provider).to_string();

        let history = {
            let state = app.state::<Conversation>();
            let mut turns = state.0.lock().expect("conversation lock");
            turns.push(("user".to_string(), prompt.clone()));
            trim_conversation(&mut turns);
            turns.clone()
        };

        // Decided once, before the first delta: whether the local engine can
        // stream. Without it the honest fallback is the old behaviour — speak
        // the whole reply at the end via the OS voice.
        let stream_audio = speak && tts_setup::is_ready(&app);
        let voice_paths = if stream_audio { resolve_voice_paths(&app) } else { None };
        let stream_audio = stream_audio && voice_paths.is_some();

        let sidecar = app.state::<tts_pocket::TtsSidecar>();
        let generation = stream_audio.then(|| sidecar.begin_utterance());
        let mut splitter = sentences::SentenceSplitter::new();

        let mut on_delta = |chunk: &str| {
            let (Some(generation), Some(paths)) = (generation, voice_paths.as_ref()) else {
                return;
            };
            for sentence in splitter.push(chunk) {
                sidecar.enqueue(paths.job(generation, sentence));
            }
        };

        match ai::stream_chat(&app, provider, &model, &history, &mut on_delta) {
            Ok(text) => {
                if let (Some(generation), Some(paths)) = (generation, voice_paths.as_ref()) {
                    if let Some(tail) = splitter.finish() {
                        sidecar.enqueue(paths.job(generation, tail));
                    }
                    sidecar.end_utterance(generation);
                } else if speak && !text.trim().is_empty() {
                    // No local engine: one OS-voice utterance at the end.
                    speak_text(app.clone(), text.clone());
                }

                {
                    let state = app.state::<Conversation>();
                    let mut turns = state.0.lock().expect("conversation lock");
                    turns.push(("assistant".to_string(), text.clone()));
                    trim_conversation(&mut turns);
                }
                let _ = app.emit("ai-done", text);
            }
            Err(e) => {
                eprintln!("[synapse] AI request failed: {e}");
                // Drop the unanswered user turn, so a retry doesn't send the
                // same question twice in the history.
                {
                    let state = app.state::<Conversation>();
                    let mut turns = state.0.lock().expect("conversation lock");
                    turns.pop();
                }
                if generation.is_some() {
                    sidecar.stop(); // clears the orb's speaking state
                }
                let _ = app.emit("ai-error", e);
            }
        }
    });
}

/// The running conversation, owned in Rust so the orb, the AI panel and any
/// future caller all see the same history. Previously neither side kept any:
/// every question was independent.
#[derive(Default)]
struct Conversation(std::sync::Mutex<Vec<(String, String)>>);

/// Each turn is re-sent in full on every request, so an unbounded history means
/// a bill that grows without limit. Oldest turns fall off in user/assistant
/// pairs, so the remaining history never starts mid-exchange.
const MAX_CONVERSATION_TURNS: usize = 20;

fn trim_conversation(turns: &mut Vec<(String, String)>) {
    while turns.len() > MAX_CONVERSATION_TURNS {
        turns.remove(0);
    }
    // Never leave an assistant message first — some APIs reject it.
    while turns.first().is_some_and(|(role, _)| role == "assistant") {
        turns.remove(0);
    }
}

#[tauri::command]
fn clear_conversation(app: tauri::AppHandle) {
    if let Ok(mut turns) = app.state::<Conversation>().0.lock() {
        turns.clear();
    }
}

/// Everything the synthesis worker needs, resolved once per utterance rather
/// than per sentence.
struct VoicePaths {
    python: std::path::PathBuf,
    script: std::path::PathBuf,
    out_dir: std::path::PathBuf,
    voice: String,
}

impl VoicePaths {
    fn job(&self, generation: u64, text: String) -> tts_pocket::SynthJob {
        tts_pocket::SynthJob {
            generation,
            text,
            python: self.python.clone(),
            script: self.script.clone(),
            out_dir: self.out_dir.clone(),
            voice: self.voice.clone(),
        }
    }
}

fn resolve_voice_paths(app: &tauri::AppHandle) -> Option<VoicePaths> {
    let voice = settings_path(app)
        .map(|p| settings::load(&p).tts.voice)
        .unwrap_or_else(|_| "alba".to_string());
    match (
        tts_setup::python_path(app),
        tts_setup::sidecar_script_path(app),
        tts_setup::tts_scratch_dir(app),
    ) {
        (Ok(python), Ok(script), Ok(out_dir)) => Some(VoicePaths {
            python,
            script,
            out_dir,
            voice,
        }),
        _ => None,
    }
}

/// Records and returns the transcript directly (no clipboard paste) — the AI
/// panel's voice-input button feeds this straight into the prompt box rather
/// than injecting it into whatever window last had focus.
#[tauri::command]
fn transcribe_for_ai(app: tauri::AppHandle) -> Result<String, String> {
    let auto_stop = auto_stop_enabled(&app);
    let tick_app = app.clone();
    asr::record_and_transcribe(auto_stop, move |t| {
        let _ = tick_app.emit(
            "dictation-tick",
            DictationTick {
                level: t.level,
                elapsed_ms: t.elapsed_ms,
                heard_speech: t.heard_speech,
            },
        );
    })
}

#[tauri::command]
fn check_mic_access() -> Result<(), String> {
    asr::check_mic_access()
}

/// Speaks text via pocket-tts when its engine is downloaded, falling back to
/// OS-native TTS otherwise (not downloaded yet, or the sidecar just failed).
/// The ENTIRE body runs on a spawned background thread — Tauri commands run
/// on the main thread by default, and the pocket-tts path (a blocking
/// subprocess round-trip that may include a multi-second first-run model
/// load) must never block it, same as the OS-fallback path already did.
#[tauri::command]
fn speak_text(app: tauri::AppHandle, text: String) {
    std::thread::spawn(move || {
        if tts_setup::is_ready(&app) {
            if let Some(paths) = resolve_voice_paths(&app) {
                let sidecar = app.state::<tts_pocket::TtsSidecar>();
                let generation = sidecar.begin_utterance();
                // Chunked even for one-shot text: a long selection would
                // otherwise be several seconds of silence before anything
                // plays, and the queue makes it start after the first sentence.
                let chunks = sentences::split_all(&text);
                if !chunks.is_empty() {
                    for chunk in chunks {
                        sidecar.enqueue(paths.job(generation, chunk));
                    }
                    sidecar.end_utterance(generation);
                    return;
                }
            }
        }

        // OS fallback. Emitted by hand because this path has no audio thread to
        // report from, and without the events the orb would never leave its
        // speaking state on a machine with no local engine installed.
        let _ = app.emit("tts-started", 0u64);
        if let Err(e) = tts::speak(&text) {
            eprintln!("[synapse] TTS failed: {e}");
            let _ = app.emit("tts-error", e);
        }
        let _ = app.emit("tts-ended", 0u64);
    });
}

/// Barge-in. Cancels whichever engine is actually live.
#[tauri::command]
fn stop_speaking(app: tauri::AppHandle) {
    app.state::<tts_pocket::TtsSidecar>().stop();
    tts::stop();
}

/// Lets a window that was hidden mid-utterance re-sync when it comes back —
/// the webview persists across show/hide, so it can miss the `tts-ended` it
/// was waiting for. Same reason the `wheel-shown` event exists.
#[tauri::command]
fn is_speaking() -> bool {
    tts::is_speaking()
}

/// Same clipboard paste-and-restore path as dictation/snippets (PRD §4.4) —
/// restores focus to the app the user was in before pasting the AI's answer.
#[tauri::command]
fn insert_ai_response(app: tauri::AppHandle, content: String) {
    if let Some(window) = app.get_webview_window(AI_LABEL) {
        let _ = window.hide();
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        #[cfg(target_os = "windows")]
        restore_previous_focus();
        if let Err(e) = inject::paste_text(&app, &content) {
            eprintln!("[synapse] AI insert failed: {e}");
        }
    });
}

/// Direct-dictation hotkey path (PRD §4.3): wheel was never opened, so show
/// it now already in listening mode.
fn begin_direct_dictation(app: &tauri::AppHandle) {
    show_overlay_at_cursor(app);
    let _ = app.emit("dictation-listening", ());
    spawn_recording(app.clone());
}

/// Wedge-click path: wheel is already visible and focus was already captured
/// when it was opened, so just switch its content to listening mode and go.
#[tauri::command]
fn start_dictation(app: tauri::AppHandle) {
    let _ = app.emit("dictation-listening", ());
    spawn_recording(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered before any other plugin. Without it a second launch
        // (clicking the desktop icon while Synapse is already in the tray) starts
        // a duplicate process whose global-shortcut registration fails, taking
        // that process down — and, because every window starts hidden, the whole
        // thing is invisible either way. Here the second launch instead summons
        // the wheel on the process that already owns the shortcuts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_overlay_at_cursor(app);
            let _ = app.emit("wheel-shown", ());
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(tts_pocket::TtsSidecar::new())
        .manage(GeometryQueue::default())
        .manage(Conversation::default())
        .invoke_handler(tauri::generate_handler![
            dismiss_overlay,
            select_wedge,
            force_quit,
            start_overlay_drag,
            reveal_path,
            start_dictation,
            stop_dictation,
            list_notes,
            get_note,
            create_note,
            save_note_content,
            set_note_color,
            open_note_window,
            close_note_window,
            delete_note,
            // File I/O for notes, from the Notepad save/open work (#1). The
            // single Notepad it was written for is gone, but the capability
            // moved to sticky notes rather than being dropped.
            save_note_to,
            load_note_from,
            list_clipboard,
            pin_clipboard_entry,
            delete_clipboard_entry,
            clear_clipboard_history,
            add_pinned_clip,
            insert_clip,
            set_api_key,
            provider_status,
            send_ai_message,
            insert_ai_response,
            transcribe_for_ai,
            check_mic_access,
            speak_text,
            stop_speaking,
            is_speaking,
            clear_conversation,
            get_settings,
            update_settings,
            open_settings,
            delete_api_key,
            model_status,
            download_model,
            tts_setup_status,
            download_tts_engine,
            check_for_update,
            download_update,
            install_update
        ])
        .setup(|app| {
            let model_dir = model_download::model_dir(app.handle())?;
            // Clears fp32 leftovers an earlier build downloaded before the
            // model preloads, so a machine that upgraded doesn't keep loading
            // the broken stub instead of the int8 files.
            model_download::remove_stale_files(&model_dir);
            asr::preload_model(model_dir);

            // Data migrations run before anything reads the new stores.
            // Snippets became pinned clipboard entries; the single notepad.txt
            // became note #1.
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                if let Err(e) = clipboard_history::migrate_snippets(&dir) {
                    eprintln!("[synapse] snippet migration failed: {e}");
                }
                if let Err(e) = notes::migrate_legacy(&dir) {
                    eprintln!("[synapse] notepad migration failed: {e}");
                }
            }
            clipboard_history::spawn_watcher(app.handle().clone());

            // Hands the TTS sidecar its AppHandle (for tts-started/ended) and
            // starts the synthesis worker. Must happen here, not at .manage()
            // time, because no AppHandle exists that early.
            app.state::<tts_pocket::TtsSidecar>().attach(app.handle().clone());

            // One flush thread for every note window, rather than one per note.
            let geometry_app = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                flush_geometry(&geometry_app);
            });

            let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse")
                .inner_size(OVERLAY_SIZE, OVERLAY_SIZE)
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false)
                .shadow(false)
                .build()?;

            #[cfg(target_os = "macos")]
            {
                let _ = window_vibrancy::apply_vibrancy(
                    &overlay,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    None,
                    Some(16.0),
                );
            }

            #[cfg(debug_assertions)]
            overlay.open_devtools();

            // The clipboard picker and the notes hub are normal decorated
            // windows (unlike the overlay) — they're content surfaces the user
            // may want to move/resize, not a transient chromeless wheel.
            // All windows load the same index.html; the frontend routes on the
            // window *label* (see App.tsx). A URL hash was tried first, but
            // Tauri escapes the '#' so window.location.hash came back empty and
            // every window rendered the wheel.
            let notes_hub = WebviewWindowBuilder::new(app, NOTES_HUB_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse - Notes")
                .inner_size(380.0, 560.0)
                .visible(false)
                .build()?;
            #[cfg(debug_assertions)]
            notes_hub.open_devtools();

            // Closing a Tauri window destroys it, after which show() silently
            // does nothing — so these utility windows intercept the close and
            // hide instead, keeping them reusable across invocations.
            // (Individual note windows are the deliberate exception; see
            // `open_note_window`.)
            let nh = notes_hub.clone();
            notes_hub.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = nh.hide();
                }
            });

            // Reopen the sticky notes that were on screen at last exit. A crash
            // leaves `open: true`, so notes come back — the forgiving direction.
            let reopen = app.handle().clone();
            for note in notes::list(&reopen).unwrap_or_default() {
                if note.open {
                    if let Err(e) = open_note_window(reopen.clone(), note.id) {
                        eprintln!("[synapse] could not reopen note: {e}");
                    }
                }
            }

            let clipboard_window =
                WebviewWindowBuilder::new(app, CLIPBOARD_LABEL, WebviewUrl::App("index.html".into()))
                    .title("Synapse - Clipboard")
                    .inner_size(460.0, 560.0)
                    .visible(false)
                    .build()?;
            #[cfg(debug_assertions)]
            clipboard_window.open_devtools();

            let sp = clipboard_window.clone();
            clipboard_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = sp.hide();
                }
            });

            // Undecorated and transparent: this window is an object you talk
            // to, and OS title-bar chrome around a glowing orb would read as a
            // dialog. Its own header carries data-tauri-drag-region instead.
            let ai_panel = WebviewWindowBuilder::new(app, AI_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse - AI")
                .inner_size(420.0, 620.0)
                .min_inner_size(340.0, 380.0)
                .decorations(false)
                .transparent(true)
                .visible(false)
                .build()?;
            #[cfg(debug_assertions)]
            ai_panel.open_devtools();

            let aip = ai_panel.clone();
            ai_panel.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = aip.hide();
                }
            });

            let settings_window = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse - Settings")
                .inner_size(720.0, 520.0)
                .visible(false)
                .build()?;
            #[cfg(debug_assertions)]
            settings_window.open_devtools();

            let sw = settings_window.clone();
            settings_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = sw.hide();
                }
            });

            // Unlike the hide-on-close utility windows above, onboarding is one-time:
            // closing it (by any means — finishing the wizard or the title-bar X) marks
            // onboarding_complete and lets the window actually be destroyed, same as
            // Tauri's default close behavior. It's shown automatically on first launch
            // and never again after that — there is no "redo onboarding" entry point.
            //
            // The flag alone isn't enough to decide: %APPDATA% survives an
            // uninstall/reinstall, so a machine that ran an earlier build carries
            // `onboarding_complete: true` into a brand-new install and would start
            // with every window hidden — which is what made the installer's "Run
            // Synapse" checkbox look like it did nothing. The NSIS post-install
            // hook drops a marker for exactly that case (see installer/hooks.nsh).
            // Consume it unconditionally rather than short-circuiting behind the
            // flag, or a marker left unread during a not-yet-onboarded launch
            // would re-trigger the wizard later.
            let initial_settings = settings::load(&settings_path(app.handle())?);
            let fresh_install = take_fresh_install_marker(&app.path().app_data_dir()?);
            let show_onboarding = fresh_install || !initial_settings.onboarding_complete;

            let onboarding = WebviewWindowBuilder::new(app, ONBOARDING_LABEL, WebviewUrl::App("index.html".into()))
                .title("Setup")
                .inner_size(480.0, 600.0)
                .resizable(false)
                .center()
                .visible(false)
                .build()?;
            #[cfg(debug_assertions)]
            onboarding.open_devtools();

            // Shown here rather than via `.visible(show_onboarding)` so it goes
            // through the Z-order dance — see `show_foreground`.
            if show_onboarding {
                show_foreground(&onboarding);
            }

            // Closing early (the X button, at any step) is treated the same as
            // finishing the wizard: mark onboarding_complete so it doesn't reappear.
            // Anything left undone (mic not granted, model not downloaded) stays
            // recoverable later — mic via Windows' own Settings, model via
            // Settings > Voice. Handled here in Rust rather than relying on frontend
            // JS to run on unload, which isn't guaranteed to fire in time.
            let onboarding_handle = app.handle().clone();
            onboarding.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if let Ok(path) = settings_path(&onboarding_handle) {
                        let mut s = settings::load(&path);
                        if !s.onboarding_complete {
                            s.onboarding_complete = true;
                            if settings::save(&path, &s).is_ok() {
                                let _ = onboarding_handle.emit("settings-changed", s);
                            }
                        }
                    }
                }
            });

            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut(
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Enter),
                move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_overlay_at_cursor(&handle);
                        let _ = handle.emit("wheel-shown", ());
                    }
                },
            )?;

            // Dedicated direct-dictation hotkey (PRD §4.3): starts Speech-to-Text
            // without opening the wheel at all, since it's the most-used action.
            let dictate_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD),
                move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        begin_direct_dictation(&dictate_handle);
                    }
                },
            )?;

            // Synapse has no main window: every window above starts hidden and is
            // summoned by hotkey, so on an already-onboarded machine launching the
            // app produced no visible feedback at all and read as a dead icon. The
            // tray is the only persistent, clickable proof it's running, and the
            // only way to reach the app or quit it without knowing the hotkeys.
            let open_item = MenuItem::with_id(app, "open", "Open wheel\tCtrl+Alt+Enter", true, None::<&str>)?;
            let dictate_item = MenuItem::with_id(app, "dictate", "Start dictation\tCtrl+Alt+D", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Synapse", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &dictate_item, &settings_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("no bundled app icon for the tray")?,
                )
                .tooltip("Synapse")
                .menu(&tray_menu)
                // Left click summons the wheel (below); without this the menu
                // would pop on left click too and swallow that gesture.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        show_overlay_at_cursor(app);
                        let _ = app.emit("wheel-shown", ());
                    }
                    "dictate" => begin_direct_dictation(app),
                    "settings" => show_utility_window(app, SETTINGS_LABEL),
                    "quit" => app.exit(0),
                    other => eprintln!("[synapse] unhandled tray menu id: {other}"),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_overlay_at_cursor(app);
                        let _ = app.emit("wheel-shown", ());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // The cached sidecar `Child` (a loaded, possibly multi-GB TTS
            // model process) is never killed by `Drop` — Rust doesn't kill
            // child processes on drop, and Windows won't reap it on its own.
            // Without this, python.exe survives Synapse exiting.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<tts_pocket::TtsSidecar>().kill();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-lib-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// The reinstall case: app data (and so `onboarding_complete`) is still
    /// there, but the installer just ran, so onboarding has to show once.
    #[test]
    fn fresh_install_marker_is_reported_once_then_consumed() {
        let dir = temp_dir("fresh-install");
        std::fs::write(dir.join(FRESH_INSTALL_MARKER), "").expect("write marker");

        assert!(
            take_fresh_install_marker(&dir),
            "marker left by the installer triggers onboarding"
        );
        assert!(
            !take_fresh_install_marker(&dir),
            "and not again on every launch after that"
        );
    }

    #[test]
    fn no_marker_reports_false() {
        let dir = temp_dir("no-marker");
        assert!(!take_fresh_install_marker(&dir));
    }
}
