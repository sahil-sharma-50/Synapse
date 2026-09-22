use base64::Engine;
use enigo::{Direction, Enigo, Key, Keyboard, Mouse};
use serde_json::{json, Value};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::HWND,
        System::Com::*,
        UI::{Accessibility::*, Shell::ShellExecuteW, WindowsAndMessaging::*},
    },
};

pub struct Desktop {
    automation: IUIAutomation,
    pub target: u32,
    elements: Vec<IUIAutomationElement>,
    pub state: Value,
    apps: Vec<(String, std::path::PathBuf)>,
    _apartment: Apartment,
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

impl Desktop {
    pub fn new() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
        }
        let apartment = Apartment;
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
        if let Ok(v2) = automation.cast::<IUIAutomation2>() {
            unsafe {
                let _ = v2.SetConnectionTimeout(1500);
                let _ = v2.SetTransactionTimeout(1500);
            }
        }
        let mut apps = vec![];
        for env in ["APPDATA", "PROGRAMDATA"] {
            if let Some(path) = std::env::var_os(env) {
                collect_apps(
                    &std::path::PathBuf::from(path).join("Microsoft/Windows/Start Menu/Programs"),
                    &mut apps,
                    0,
                );
            }
        }
        apps.sort_by_key(|(name, _)| name.to_lowercase());
        apps.dedup_by(|a, b| a.0.eq_ignore_ascii_case(&b.0));
        Ok(Self {
            automation,
            target: crate::PREVIOUS_FOCUS.load(std::sync::atomic::Ordering::SeqCst) as u32,
            elements: vec![],
            state: Value::Null,
            apps,
            _apartment: apartment,
        })
    }

    pub fn observe(&mut self) -> Result<&Value, String> {
        let windows = xcap::Window::all().map_err(|e| e.to_string())?;
        let usable: Vec<_> = windows
            .into_iter()
            .filter(|w| w.pid().ok() != Some(std::process::id()) && w.title().is_ok_and(|s| !s.is_empty()))
            .collect();
        let foreground = unsafe { GetForegroundWindow() }.0 as usize as u32;
        if usable.iter().any(|w| w.id().ok() == Some(foreground)) {
            self.target = foreground;
        }
        if !usable.iter().any(|w| w.id().ok() == Some(self.target)) {
            self.target = usable
                .first()
                .and_then(|w| w.id().ok())
                .ok_or("No accessible application window")?;
        }
        let window = usable.iter().find(|w| w.id().ok() == Some(self.target)).unwrap();
        let title = window.title().unwrap_or_default();
        let app = window.app_name().unwrap_or_default();
        self.elements.clear();
        let mut controls = vec![];
        unsafe {
            let root = self
                .automation
                .ElementFromHandle(self.hwnd())
                .map_err(|e| e.to_string())?;
            let walker = self.automation.ControlViewWalker().map_err(|e| e.to_string())?;
            let mut queue = std::collections::VecDeque::from([root]);
            let start = std::time::Instant::now();
            // ponytail: bounded active-window tree; use targeted subtree queries if large apps need more.
            while let Some(element) = queue.pop_front() {
                if self.elements.len() >= 180 || start.elapsed().as_secs() >= 3 {
                    break;
                }
                if element.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                    continue;
                }
                if !element.CurrentIsOffscreen().map(|b| b.as_bool()).unwrap_or(true) {
                    let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                    let kind = element
                        .CurrentLocalizedControlType()
                        .map(|n| n.to_string())
                        .unwrap_or_default();
                    let control_type = element.CurrentControlType().ok();
                    let value =
                        if [Some(UIA_EditControlTypeId), Some(UIA_ComboBoxControlTypeId)].contains(&control_type) {
                            element
                                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                                .and_then(|p| p.CurrentValue())
                                .map(|v| v.to_string())
                                .unwrap_or_default()
                        } else {
                            String::new()
                        };
                    if !name.is_empty()
                        || control_type == Some(UIA_EditControlTypeId)
                        || control_type == Some(UIA_DocumentControlTypeId)
                    {
                        controls.push(
                            json!({"id":self.elements.len(), "name":name.chars().take(180).collect::<String>(),
                            "kind":kind,"focused":element.CurrentHasKeyboardFocus().is_ok_and(|b| b.as_bool()),
                            "value":value.chars().take(1200).collect::<String>()}),
                        );
                        self.elements.push(element.clone());
                    }
                }
                if let Ok(mut child) = walker.GetFirstChildElement(&element) {
                    for _ in 0..180 {
                        queue.push_back(child.clone());
                        let Ok(next) = walker.GetNextSiblingElement(&child) else {
                            break;
                        };
                        child = next;
                    }
                }
            }
        }
        self.state = json!({"window":self.target,"title":title,"app":app,"controls":controls,
            "windows": usable.iter().take(40).map(|w| json!({"id":w.id().ok(),"title":w.title().ok(),"app":w.app_name().ok()})).collect::<Vec<_>>(),
            "apps":self.apps.iter().map(|(name,_)| name).collect::<Vec<_>>()});
        Ok(&self.state)
    }

    fn hwnd(&self) -> HWND {
        HWND(self.target as usize as *mut _)
    }

    pub fn focus(&self) -> Result<(), String> {
        let current = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id().ok() == Some(self.target))
            .ok_or("Target window closed")?;
        let observed = self.state["windows"]
            .as_array()
            .and_then(|ws| ws.iter().find(|w| w["id"].as_u64() == Some(self.target as u64)))
            .ok_or("Observe the target window first")?;
        if current.title().ok().as_deref() != observed["title"].as_str()
            || current.app_name().ok().as_deref() != observed["app"].as_str()
        {
            return Err("Target window changed. Observe it again before acting.".into());
        }
        unsafe {
            if IsIconic(self.hwnd()).as_bool() {
                let _ = ShowWindow(self.hwnd(), SW_RESTORE);
            }
            let _ = SetForegroundWindow(self.hwnd());
            if GetForegroundWindow() != self.hwnd() {
                return Err("Windows blocked focus. Select the target app and try again.".into());
            }
        }
        Ok(())
    }

    pub fn element_name(&self, id: usize) -> Result<String, String> {
        let element = self
            .elements
            .get(id)
            .ok_or("Unknown control. Observe the window again.")?;
        unsafe {
            if element.CurrentIsPassword().map_err(|e| e.to_string())?.as_bool() {
                return Err("Enter passwords yourself.".into());
            }
            let name = element.CurrentName().map_err(|e| e.to_string())?.to_string();
            let prior = self.state["controls"][id]["name"].as_str().unwrap_or_default();
            if name.chars().take(180).collect::<String>() != prior {
                return Err("Control changed; observe again.".into());
            }
            Ok(name)
        }
    }

    pub fn click(&self, id: usize) -> Result<(), String> {
        self.element_name(id)?;
        self.focus()?;
        let element = &self.elements[id];
        unsafe {
            if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                return pattern.Invoke().map_err(|e| e.to_string());
            }
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            {
                return pattern.Select().map_err(|e| e.to_string());
            }
            let rect = element.CurrentBoundingRectangle().map_err(|e| e.to_string())?;
            self.click_at((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
        }
    }

    pub fn type_text(&self, id: usize, text: &str) -> Result<(), String> {
        self.element_name(id)?;
        if text.len() > 8000 {
            return Err("Type at most 8,000 bytes at a time.".into());
        }
        self.focus()?;
        unsafe {
            let kind = self.elements[id].CurrentControlType().map_err(|e| e.to_string())?;
            if ![
                UIA_EditControlTypeId,
                UIA_DocumentControlTypeId,
                UIA_ComboBoxControlTypeId,
            ]
            .contains(&kind)
            {
                return Err("This control is not an editable field.".into());
            }
            self.elements[id].SetFocus().map_err(|e| e.to_string())?;
            if let Ok(pattern) = self.elements[id].GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                return pattern
                    .SetValue(&windows::core::BSTR::from(text))
                    .map_err(|e| e.to_string());
            }
        }
        self.key("ctrl+a")?;
        Enigo::new(&enigo::Settings::default())
            .map_err(|e| e.to_string())?
            .text(text)
            .map_err(|e| e.to_string())
    }

    pub fn key(&self, key: &str) -> Result<(), String> {
        self.focus()?;
        let (modifier, key) = match key {
            "enter" => (None, Key::Return),
            "tab" => (None, Key::Tab),
            "escape" => (None, Key::Escape),
            "up" => (None, Key::UpArrow),
            "down" => (None, Key::DownArrow),
            "left" => (None, Key::LeftArrow),
            "right" => (None, Key::RightArrow),
            "backspace" => (None, Key::Backspace),
            "f5" => (None, Key::F5),
            "ctrl+l" => (Some(Key::Control), Key::Unicode('l')),
            "ctrl+t" => (Some(Key::Control), Key::Unicode('t')),
            "ctrl+w" => (Some(Key::Control), Key::Unicode('w')),
            "ctrl+a" => (Some(Key::Control), Key::Unicode('a')),
            "ctrl+s" => (Some(Key::Control), Key::Unicode('s')),
            _ => return Err("Unsupported key".into()),
        };
        let mut input = Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        if let Some(modifier) = modifier {
            input.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
        }
        let result = input.key(key, Direction::Click).map_err(|e| e.to_string());
        if let Some(modifier) = modifier {
            input.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
        }
        result
    }

    pub fn scroll(&self, amount: i32) -> Result<(), String> {
        self.focus()?;
        let mut rect = windows::Win32::Foundation::RECT::default();
        unsafe {
            GetWindowRect(self.hwnd(), &mut rect).map_err(|e| e.to_string())?;
        }
        self.move_pointer((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)?
            .scroll(amount.clamp(-12, 12), enigo::Axis::Vertical)
            .map_err(|e| e.to_string())
    }

    pub fn open_app(&self, name: &str) -> Result<(), String> {
        if matches!(name.to_lowercase().as_str(), "chrome" | "google chrome") {
            return open_chrome(&|| false).map(|_| ());
        }
        if let Some((_, path)) = self.apps.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
            return shell_open(path.to_str().ok_or("Invalid application path")?);
        }
        match name.to_lowercase().as_str() {
            "notepad" => shell_open("notepad.exe"),
            "calculator" => shell_open("calc.exe"),
            "file explorer" => shell_open("explorer.exe"),
            _ => Err("Application not found in the Start menu. Use its exact listed name.".into()),
        }
    }

    pub fn open_url(&self, url: &str) -> Result<(), String> {
        validate_url(url)?;
        launch_chrome(url)
    }

    pub fn screenshot(&self) -> Result<String, String> {
        let window = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id().ok() == Some(self.target))
            .ok_or("Target window closed")?;
        // Capture only the task window, never the full desktop. Password controls are omitted above;
        // screenshot capture is refused when the active window exposes a password field.
        unsafe {
            let focused = self.automation.GetFocusedElement().map_err(|e| e.to_string())?;
            if focused.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                return Err("Finish password entry yourself before requesting a screenshot.".into());
            }
        }
        let frame =
            image::DynamicImage::ImageRgba8(window.capture_image().map_err(|e| e.to_string())?).thumbnail(1280, 800);
        let mut png = std::io::Cursor::new(Vec::new());
        frame
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        ))
    }

    pub fn click_point(&self, x: f64, y: f64) -> Result<(), String> {
        if !x.is_finite() || !y.is_finite() || !(0.0..1.0).contains(&x) || !(0.0..1.0).contains(&y) {
            return Err("Invalid coordinates".into());
        }
        self.focus()?;
        let mut rect = windows::Win32::Foundation::RECT::default();
        unsafe {
            GetWindowRect(self.hwnd(), &mut rect).map_err(|e| e.to_string())?;
        }
        self.click_at(
            rect.left + (x * (rect.right - rect.left) as f64) as i32,
            rect.top + (y * (rect.bottom - rect.top) as f64) as i32,
        )
    }

    fn click_at(&self, x: i32, y: i32) -> Result<(), String> {
        self.move_pointer(x, y)?
            .button(enigo::Button::Left, Direction::Click)
            .map_err(|e| e.to_string())
    }

    fn move_pointer(&self, x: i32, y: i32) -> Result<Enigo, String> {
        let hit = unsafe { GetAncestor(WindowFromPoint(windows::Win32::Foundation::POINT { x, y }), GA_ROOT) };
        if hit != self.hwnd() {
            return Err("The target is covered by another window. Move the orb or uncover the target.".into());
        }
        let mut input = Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        input
            .move_mouse(x, y, enigo::Coordinate::Abs)
            .map_err(|e| e.to_string())?;
        Ok(input)
    }
}

fn launch_chrome(url: &str) -> Result<(), String> {
    for env in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(env) {
            let path = std::path::PathBuf::from(root).join("Google/Chrome/Application/chrome.exe");
            if path.is_file() {
                std::process::Command::new(path)
                    .arg("--new-tab")
                    .arg(url)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err("Google Chrome is not installed in a standard location.".into())
}

pub fn open_chrome(cancelled: &dyn Fn() -> bool) -> Result<u32, String> {
    if cancelled() {
        return Err("Task stopped".into());
    }
    launch_chrome("chrome://newtab")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        if cancelled() {
            return Err("Task stopped".into());
        }
        let windows = xcap::Window::all().map_err(|e| e.to_string())?;
        if let Some(window) = windows.iter().find(|window| {
            window.is_focused().unwrap_or(false)
                && !window.is_minimized().unwrap_or(true)
                && window.app_name().is_ok_and(|name| {
                    matches!(name.to_lowercase().trim_end_matches(".exe"), "chrome" | "google chrome")
                })
        }) {
            return window.id().map_err(|e| e.to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(
        "Chrome was launched, but Windows did not bring its window to the front. Select Chrome from the taskbar."
            .into(),
    )
}

fn collect_apps(path: &std::path::Path, apps: &mut Vec<(String, std::path::PathBuf)>, depth: u8) {
    if depth > 5 || apps.len() > 300 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
            collect_apps(&path, apps, depth + 1);
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                apps.push((name.into(), path));
            }
        }
    }
}

pub fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Use a complete https:// URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 4000
    {
        return Err("Only HTTP(S) browser addresses without embedded credentials are supported.".into());
    }
    Ok(())
}

fn shell_open(target: &str) -> Result<(), String> {
    let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if result.0 as usize <= 32 {
        Err("Windows could not open the application".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Opens one Chrome tab and verifies its real foreground window; no API calls"]
    fn live_chrome_launch_reaches_a_verified_window() {
        let id = open_chrome(&|| false).expect("Chrome should open and become the foreground window");
        assert!(id > 0);
        assert!(
            open_chrome(&|| true).is_err(),
            "Cancellation must prevent another launch"
        );
        println!("Chrome launch verified in foreground (window {id})");
    }
    #[test]
    fn rejects_executable_urls_and_embedded_credentials() {
        for url in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/cmd.exe",
            "data:text/html,test",
            "https://user:secret@example.com",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(validate_url("https://example.com/path").is_ok());
    }

    #[test]
    #[ignore = "Reads the active desktop accessibility tree locally; no network or input actions"]
    fn live_native_observation() {
        let mut desktop = Desktop::new().unwrap();
        let state = desktop.observe().unwrap();
        assert!(state["window"].as_u64().unwrap() > 0);
        assert!(state["windows"].as_array().is_some_and(|windows| !windows.is_empty()));
        println!(
            "Native observation: {} accessible controls, {} installed app shortcuts",
            state["controls"].as_array().unwrap().len(),
            state["apps"].as_array().unwrap().len()
        );
    }
}
