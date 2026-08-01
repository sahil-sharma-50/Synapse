mod ai;
mod asr;
mod inject;
mod model_download;
mod notes;
mod screenshot;
mod snippets;
mod settings;
mod tts;
mod tts_pocket;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const OVERLAY_LABEL: &str = "overlay";
const NOTEPAD_LABEL: &str = "notepad";
const SNIPPET_LABEL: &str = "snippet-picker";
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
                let message = match screenshot::capture(&app, cursor) {
                    Ok(path) => {
                        println!("[synapse] screenshot saved to {}", path.display());
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        format!("Saved to Pictures\u{2044}Synapse\n{name}")
                    }
                    Err(e) => {
                        eprintln!("[synapse] screenshot failed: {e}");
                        format!("Screenshot failed: {e}")
                    }
                };
                show_toast(&app, message);
            });
        }
        "notepad" => {
            hide_overlay(&app);
            show_utility_window(&app, NOTEPAD_LABEL);
        }
        "snippet" => {
            hide_overlay(&app);
            show_utility_window(&app, SNIPPET_LABEL);
        }
        "ai" => {
            hide_overlay(&app);
            show_utility_window(&app, AI_LABEL);
        }
        "settings" => {
            hide_overlay(&app);
            show_utility_window(&app, SETTINGS_LABEL);
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
fn show_toast(app: &tauri::AppHandle, message: String) {
    let _ = app.emit("toast", message);
    // Let the webview render the toast state before the window is shown,
    // otherwise the wheel flashes for a frame first.
    std::thread::sleep(std::time::Duration::from_millis(60));
    show_overlay_at_cursor(app);
    std::thread::sleep(std::time::Duration::from_millis(1500));
    hide_overlay(app);
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

#[tauri::command]
fn load_note(app: tauri::AppHandle) -> Result<String, String> {
    notes::read(&app)
}

#[tauri::command]
fn save_note(app: tauri::AppHandle, content: String) -> Result<(), String> {
    notes::write(&app, &content)
}

#[tauri::command]
fn list_snippets(app: tauri::AppHandle) -> Result<Vec<snippets::Snippet>, String> {
    snippets::list(&app)
}

#[tauri::command]
fn add_snippet(app: tauri::AppHandle, name: String, content: String) -> Result<snippets::Snippet, String> {
    println!("[synapse] add_snippet: name={name:?} content={content:?}");
    snippets::add(&app, name, content)
}

#[tauri::command]
fn delete_snippet(app: tauri::AppHandle, id: String) -> Result<(), String> {
    snippets::delete(&app, &id)
}

/// Restores focus to the app the user was in before the wheel/picker opened
/// (captured back when the overlay was first shown) and pastes the snippet
/// there — same clipboard paste-and-restore path as dictation (PRD §4.4).
#[tauri::command]
fn insert_snippet(app: tauri::AppHandle, content: String) {
    println!("[synapse] insert_snippet: {content:?}");
    if let Some(window) = app.get_webview_window(SNIPPET_LABEL) {
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
            eprintln!("[synapse] snippet paste failed: {e}");
        }
    });
}

/// Records, transcribes, and pastes on a background thread so the UI/event-
/// loop thread never blocks on microphone I/O or model inference. The wheel
/// stays visible (in "listening" mode, driven by the `dictation-listening`
/// event the caller emits beforehand) until this finishes, so the user has
/// something to look at while recording instead of the wheel just vanishing.
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

        match asr::record_and_transcribe() {
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

/// Mirrors snippets::store_path — settings.json lives beside snippets.json.
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

/// Resolves provider and model itself from settings rather than trusting a
/// frontend-supplied provider: the AI panel may invoke this before its own
/// `get_settings` call has resolved, and a missing/undefined argument would
/// fail Tauri's argument deserialization before this function body ever runs
/// — leaving `streaming` stuck `true` client-side with no `ai-done`/`ai-error`
/// event to clear it. Resolving server-side eliminates that case entirely.
#[tauri::command]
fn send_ai_message(app: tauri::AppHandle, prompt: String) {
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
        match ai::stream_chat(&app, provider, &model, &prompt) {
            Ok(text) => {
                let _ = app.emit("ai-done", text);
            }
            Err(e) => {
                eprintln!("[synapse] AI request failed: {e}");
                let _ = app.emit("ai-error", e);
            }
        }
    });
}

/// Records and returns the transcript directly (no clipboard paste) — the AI
/// panel's voice-input button feeds this straight into the prompt box rather
/// than injecting it into whatever window last had focus.
#[tauri::command]
fn transcribe_for_ai() -> Result<String, String> {
    asr::record_and_transcribe()
}

#[tauri::command]
fn check_mic_access() -> Result<(), String> {
    asr::check_mic_access()
}

/// Speaks text via OS-native TTS on a background thread so the UI isn't
/// blocked for the duration of playback.
#[tauri::command]
fn speak_text(text: String) {
    std::thread::spawn(move || {
        if let Err(e) = tts::speak(&text) {
            eprintln!("[synapse] TTS failed: {e}");
        }
    });
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
        .invoke_handler(tauri::generate_handler![
            dismiss_overlay,
            select_wedge,
            start_dictation,
            stop_dictation,
            load_note,
            save_note,
            list_snippets,
            add_snippet,
            delete_snippet,
            insert_snippet,
            set_api_key,
            provider_status,
            send_ai_message,
            insert_ai_response,
            transcribe_for_ai,
            check_mic_access,
            speak_text,
            get_settings,
            update_settings,
            open_settings,
            delete_api_key,
            model_status,
            download_model
        ])
        .setup(|app| {
            let model_dir = model_download::model_dir(app.handle())?;
            // Clears fp32 leftovers an earlier build downloaded before the
            // model preloads, so a machine that upgraded doesn't keep loading
            // the broken stub instead of the int8 files.
            model_download::remove_stale_files(&model_dir);
            asr::preload_model(model_dir);

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

            // Notepad and Snippet picker are normal decorated windows (unlike
            // the overlay) — they're content-editing surfaces the user may
            // want to move/resize, not a transient chromeless wheel.
            // All windows load the same index.html; the frontend routes on the
            // window *label* (see App.tsx). A URL hash was tried first, but
            // Tauri escapes the '#' so window.location.hash came back empty and
            // every window rendered the wheel.
            let notepad = WebviewWindowBuilder::new(app, NOTEPAD_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse - Notepad")
                .inner_size(480.0, 600.0)
                .visible(false)
                .build()?;
            #[cfg(debug_assertions)]
            notepad.open_devtools();

            // Closing a Tauri window destroys it, after which show() silently
            // does nothing — so these utility windows intercept the close and
            // hide instead, keeping them reusable across invocations.
            let np = notepad.clone();
            notepad.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = np.hide();
                }
            });

            let snippet_picker = WebviewWindowBuilder::new(app, SNIPPET_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse - Snippets")
                .inner_size(420.0, 520.0)
                .visible(false)
                .build()?;
            #[cfg(debug_assertions)]
            snippet_picker.open_devtools();

            let sp = snippet_picker.clone();
            snippet_picker.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = sp.hide();
                }
            });

            let ai_panel = WebviewWindowBuilder::new(app, AI_LABEL, WebviewUrl::App("index.html".into()))
                .title("Synapse - AI")
                .inner_size(420.0, 560.0)
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

            let settings_window =
                WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("index.html".into()))
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

            let onboarding =
                WebviewWindowBuilder::new(app, ONBOARDING_LABEL, WebviewUrl::App("index.html".into()))
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
            let dictate_item =
                MenuItem::with_id(app, "dictate", "Start dictation\tCtrl+Alt+D", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Synapse", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&open_item, &dictate_item, &settings_item, &quit_item],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().ok_or("no bundled app icon for the tray")?)
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
