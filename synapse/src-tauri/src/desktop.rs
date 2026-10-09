use base64::Engine;
use enigo::{Direction, Enigo, Key, Keyboard, Mouse};
use serde_json::{json, Value};
use std::os::windows::ffi::OsStrExt;
use std::{path::PathBuf, sync::Mutex};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, FILETIME, HWND},
        System::{Com::*, Threading::*},
        UI::{Accessibility::*, Shell::*, WindowsAndMessaging::*},
    },
};

pub struct Desktop {
    automation: IUIAutomation,
    target: Option<WindowIdentity>,
    elements: Vec<IUIAutomationElement>,
    observed_windows: Vec<WindowIdentity>,
    pub state: Value,
    apps: Vec<(String, std::path::PathBuf)>,
    _apartment: Apartment,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct WindowIdentity {
    pub window: u32,
    pub pid: u32,
    pub process_started_at: u64,
    pub app: String,
    pub title: String,
    pub observed_at_ms: i64,
    #[serde(skip)]
    pub executable: PathBuf,
}

static LAST_EXTERNAL: Mutex<Option<WindowIdentity>> = Mutex::new(None);

pub fn capture_external_target() -> Result<Option<WindowIdentity>, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if hwnd.0.is_null() || pid == std::process::id() {
        return Ok(None);
    }
    window_identity(hwnd.0 as usize as u32).map(Some)
}

pub fn remember_external_target() {
    if let Ok(Some(identity)) = capture_external_target() {
        crate::PREVIOUS_FOCUS.store(identity.window as isize, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut last) = LAST_EXTERNAL.lock() {
            *last = Some(identity);
        }
    }
}

pub fn invocation_target() -> Option<WindowIdentity> {
    capture_external_target()
        .ok()
        .flatten()
        .or_else(|| LAST_EXTERNAL.lock().ok().and_then(|v| v.clone()))
}

fn window_identity(window: u32) -> Result<WindowIdentity, String> {
    unsafe {
        let hwnd = HWND(window as usize as *mut _);
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("Target window closed".into());
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|e| e.to_string())?;
        let result = (|| {
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user).map_err(|e| e.to_string())?;
            let mut name = vec![0u16; 32768];
            let mut len = name.len() as u32;
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(name.as_mut_ptr()),
                &mut len,
            )
            .map_err(|e| e.to_string())?;
            let path = PathBuf::from(String::from_utf16_lossy(&name[..len as usize]));
            let mut title = vec![0u16; (GetWindowTextLengthW(hwnd).max(0) + 1) as usize];
            let len = GetWindowTextW(hwnd, &mut title);
            Ok(WindowIdentity {
                window,
                pid,
                process_started_at: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                app: path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
                title: String::from_utf16_lossy(&title[..len as usize]),
                observed_at_ms: crate::ids::now_ms(),
                executable: path,
            })
        })();
        let _ = CloseHandle(process);
        result
    }
}

fn validate_identity(old: &WindowIdentity, current: &WindowIdentity) -> Result<(), String> {
    if old.window != current.window || old.pid != current.pid || old.process_started_at != current.process_started_at {
        Err("Target window was replaced. Select the app and try again.".into())
    } else {
        Ok(())
    }
}

fn observed_identity<'a>(
    target: Option<&WindowIdentity>,
    windows: &'a [WindowIdentity],
) -> Result<&'a WindowIdentity, String> {
    let target = target.ok_or("Select an application before requesting its context.")?;
    let current = windows
        .iter()
        .find(|w| w.window == target.window)
        .ok_or("Target window closed")?;
    validate_identity(target, current)?;
    Ok(current)
}

fn listed_identity<'a>(listed: &'a [WindowIdentity], current: &WindowIdentity) -> Result<&'a WindowIdentity, String> {
    let original = listed
        .iter()
        .find(|w| w.window == current.window)
        .ok_or("Window was not in the current observation")?;
    validate_identity(original, current)?;
    Ok(original)
}

fn same_observation(old: &WindowIdentity, current: &WindowIdentity) -> bool {
    validate_identity(old, current).is_ok() && old.title == current.title && old.app == current.app
}

fn validate_input_target(
    target: &WindowIdentity,
    current: &WindowIdentity,
    foreground: u32,
    foreground_pid: u32,
) -> Result<(), String> {
    if !same_observation(target, current) {
        return Err("Target changed. Observe it again before acting.".into());
    }
    if foreground != target.window && foreground_pid != std::process::id() {
        return Err("You switched apps. Select the intended target and ask again.".into());
    }
    Ok(())
}

fn chrome_page_matches(page: &str, title: &str, windows: usize) -> bool {
    windows == 1
        && !page.is_empty()
        && title
            .strip_prefix(page)
            .is_some_and(|tail| tail.starts_with(" - ") && tail.contains("Google Chrome"))
}

#[derive(Default, Debug, serde::Serialize)]
pub struct ExplorerContext {
    pub folder: Option<PathBuf>,
    pub selected: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct AppCandidate {
    pub id: String,
    pub name: String,
    pub launch_path: Option<PathBuf>,
    pub executable: Option<PathBuf>,
    pub windows: Vec<WindowIdentity>,
}

#[derive(Debug)]
pub struct AppActivation {
    pub target: Option<WindowIdentity>,
    pub accepted: bool,
    pub verified: bool,
    pub detail: String,
}

pub struct OpenEvidence {
    pub requested: PathBuf,
    pub accepted: bool,
    pub verified: bool,
    pub target: Option<WindowIdentity>,
    pub detail: String,
}
impl OpenEvidence {
    fn document_accepted(path: PathBuf) -> Self {
        Self {
            requested: path,
            accepted: true,
            verified: false,
            target: None,
            detail: "Sent the file to its default app; I couldn't verify it opened".into(),
        }
    }
    pub fn require_verified(self) -> Result<String, String> {
        if self.verified {
            Ok(self.detail)
        } else {
            Err(self.detail)
        }
    }
}

fn paths_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
    let normalize = |path: &std::path::Path| {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    normalize(a) == normalize(b)
}

pub fn known_search_roots() -> Vec<PathBuf> {
    [dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir()]
        .into_iter()
        .flatten()
        .collect()
}

fn app_name(name: &str) -> String {
    let name = name.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    match name.trim_end_matches(".exe") {
        "vs code" | "vscode" | "code" | "visual studio code" => "visual studio code".into(),
        "google chrome" | "chrome browser" | "chrome" => "chrome".into(),
        "explorer" | "windows explorer" | "file explorer" => "file explorer".into(),
        "calc" | "calculatorapp" | "calculator" => "calculator".into(),
        other => other.into(),
    }
}

fn match_apps(query: &str, apps: &[AppCandidate]) -> Vec<AppCandidate> {
    let query = app_name(query);
    if query.is_empty() {
        return vec![];
    }
    let exact: Vec<_> = apps.iter().filter(|a| app_name(&a.name) == query).cloned().collect();
    if !exact.is_empty() {
        return exact;
    }
    apps.iter()
        .filter(|a| {
            query
                .split_whitespace()
                .all(|q| app_name(&a.name).split_whitespace().any(|w| w == q))
        })
        .cloned()
        .collect()
}

fn window_matches_app(candidate: &AppCandidate, window: &WindowIdentity) -> bool {
    match &candidate.executable {
        Some(path) if path.is_absolute() => paths_equal(path, &window.executable),
        _ => app_name(&candidate.name) == app_name(&window.app),
    }
}

fn launch_allowed(switch_only: bool, windows: usize) -> Result<(), String> {
    if windows > 1 {
        Err("More than one window matches. Choose a window.".into())
    } else if switch_only && windows == 0 {
        Err("That app is not running. Ask me to open it instead.".into())
    } else {
        Ok(())
    }
}

fn shortcut_executable(path: &std::path::Path) -> Option<PathBuf> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        file.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let mut path = vec![0u16; 32768];
        link.GetPath(&mut path, std::ptr::null_mut(), 0).ok()?;
        let len = path.iter().position(|c| *c == 0)?;
        (len > 0).then(|| PathBuf::from(String::from_utf16_lossy(&path[..len])))
    }
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
        apps.dedup_by(|a, b| a.1 == b.1);
        Ok(Self {
            automation,
            target: capture_external_target()
                .ok()
                .flatten()
                .or_else(|| LAST_EXTERNAL.lock().ok().and_then(|v| v.clone())),
            elements: vec![],
            observed_windows: vec![],
            state: Value::Null,
            apps,
            _apartment: apartment,
        })
    }

    pub fn observe(&mut self) -> Result<&Value, String> {
        self.observe_target()
    }

    pub fn observe_target(&mut self) -> Result<&Value, String> {
        let windows = xcap::Window::all().map_err(|e| e.to_string())?;
        let usable: Vec<_> = windows
            .into_iter()
            .filter(|w| w.pid().ok() != Some(std::process::id()) && w.title().is_ok_and(|s| !s.is_empty()))
            .collect();
        let id = self
            .target_id()
            .ok_or("Select an application before requesting its context.")?;
        let identities = [window_identity(id)?];
        let current = observed_identity(self.target.as_ref(), &identities)?.clone();
        let title = current.title.clone();
        let app = current.app.clone();
        self.target = Some(current);
        self.observed_windows = usable
            .iter()
            .take(40)
            .filter_map(|w| w.id().ok().and_then(|id| window_identity(id).ok()))
            .collect();
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
        let explorer = self.explorer_context();
        self.state = json!({"window":id,"title":title,"app":app,"controls":controls,
            "selected_text":self.selected_text().ok().flatten(),
            "explorer":explorer.as_ref().ok(),"context_limit":explorer.err(),
            "windows": self.observed_windows.iter().map(|w| json!({"id":w.window,"title":w.title,"app":w.app})).collect::<Vec<_>>(),
            "apps":self.apps.iter().map(|(name,_)| name).collect::<Vec<_>>()});
        Ok(&self.state)
    }

    fn hwnd(&self) -> HWND {
        HWND(self.target_id().unwrap_or_default() as usize as *mut _)
    }

    pub fn target_id(&self) -> Option<u32> {
        self.target.as_ref().map(|w| w.window)
    }

    pub fn target_identity(&self) -> Option<&WindowIdentity> {
        self.target.as_ref()
    }

    pub fn set_context_target(&mut self, target: Option<WindowIdentity>) {
        self.target = target;
        self.elements.clear();
        self.state = Value::Null;
    }

    pub fn select_target(&mut self, window: u32) -> Result<(), String> {
        let target = window_identity(window)?;
        if target.pid == std::process::id() {
            return Err("Choose an app outside Synapse.".into());
        }
        self.target = Some(target);
        self.elements.clear();
        self.state = Value::Null;
        Ok(())
    }

    pub fn select_observed_target(&mut self, window: u32) -> Result<(), String> {
        let current = window_identity(window)?;
        let original = listed_identity(&self.observed_windows, &current)?.clone();
        self.set_context_target(Some(original));
        Ok(())
    }

    pub fn selected_text(&self) -> Result<Option<String>, String> {
        let target = self.target.as_ref().ok_or("No target window")?;
        validate_identity(target, &window_identity(target.window)?)?;
        // The orb owns focus; ask text controls in the captured window for their retained selection.
        unsafe {
            for element in &self.elements {
                if element.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                    continue;
                }
                let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else {
                    continue;
                };
                let Ok(ranges) = pattern.GetSelection() else {
                    continue;
                };
                let mut text = String::new();
                for i in 0..ranges.Length().map_err(|e| e.to_string())?.min(16) {
                    let remaining = 4000 - text.chars().count();
                    if remaining == 0 {
                        break;
                    }
                    text.push_str(
                        &ranges
                            .GetElement(i)
                            .and_then(|r| r.GetText(remaining as i32))
                            .map_err(|e| e.to_string())?
                            .to_string(),
                    );
                }
                if !text.is_empty() {
                    return Ok(Some(text));
                }
            }
            Ok(None)
        }
    }

    pub fn matches_chrome_page(&self, page_title: &str) -> Result<bool, String> {
        let target = self.target.as_ref().ok_or("No target window")?;
        let current = window_identity(target.window)?;
        if !same_observation(target, &current) || !current.app.eq_ignore_ascii_case("chrome") {
            return Ok(false);
        }
        let count = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|w| {
                w.app_name().is_ok_and(|name| app_name(&name) == "chrome")
                    && w.title().is_ok_and(|title| !title.is_empty())
            })
            .count();
        // Multiple native Chrome windows cannot be paired reliably with the companion's last focused tab.
        Ok(chrome_page_matches(page_title, &current.title, count))
    }

    pub fn explorer_context(&self) -> Result<ExplorerContext, String> {
        let target = self.target.as_ref().ok_or("No target window")?;
        if !target.app.eq_ignore_ascii_case("explorer") {
            return Ok(ExplorerContext::default());
        }
        validate_identity(target, &window_identity(target.window)?)?;
        let target_window = target.window;
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
            let _apartment = Apartment;
            let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let mut contexts = vec![];
            for index in 0..shell.Count().map_err(|e| e.to_string())?.min(100) {
                let Ok(dispatch) = shell.Item(&windows::Win32::System::Variant::VARIANT::from(index)) else {
                    continue;
                };
                let Ok(browser) = dispatch.cast::<IWebBrowserApp>() else {
                    continue;
                };
                if browser.HWND().map(|h| h.0 as u32).ok() != Some(target_window) {
                    continue;
                }
                let provider = dispatch.cast::<IServiceProvider>().map_err(|e| e.to_string())?;
                let browser: IShellBrowser = provider
                    .QueryService(&SID_STopLevelBrowser)
                    .map_err(|e| e.to_string())?;
                let view = browser.QueryActiveShellView().map_err(|e| e.to_string())?;
                let view_window = view.GetWindow().map_err(|e| e.to_string())?;
                if !IsWindowVisible(view_window).as_bool() {
                    continue;
                }
                let folder_view: IFolderView2 = view.cast().map_err(|e| e.to_string())?;
                let folder: IPersistFolder2 = folder_view.GetFolder().map_err(|e| e.to_string())?;
                let pidl = folder.GetCurFolder().map_err(|e| e.to_string())?;
                let item: windows::core::Result<IShellItem> = SHCreateItemFromIDList(pidl);
                CoTaskMemFree(Some(pidl.cast()));
                let folder = item.ok().and_then(|item| shell_item_path(&item).ok());
                let mut selected = vec![];
                if let Ok(items) = folder_view.GetSelection(false) {
                    for i in 0..items.GetCount().map_err(|e| e.to_string())?.min(100) {
                        let item = items.GetItemAt(i).map_err(|e| e.to_string())?;
                        selected.push(shell_item_path(&item)?);
                    }
                }
                contexts.push(ExplorerContext { folder, selected });
            }
            if contexts.len() != 1 {
                return Err("Explorer's active folder is unavailable or ambiguous. Specify a folder path.".into());
            }
            Ok(contexts.remove(0))
        })
        .join()
        .map_err(|_| "Explorer context worker stopped".to_string())?
    }

    fn prepare_input(&self) -> Result<(), String> {
        let target = self.target.as_ref().ok_or("No target window")?;
        let current = window_identity(target.window)?;
        let foreground = unsafe { GetForegroundWindow() };
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(foreground, Some(&mut pid));
        }
        validate_input_target(target, &current, foreground.0 as usize as u32, pid)?;
        self.focus()
    }

    pub fn focus(&self) -> Result<(), String> {
        let target = self.target.as_ref().ok_or("No target window")?;
        validate_identity(target, &window_identity(target.window)?)?;
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
        self.prepare_input()?;
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
        self.prepare_input()?;
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
        self.prepare_input()?;
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
        self.prepare_input()?;
        let mut rect = windows::Win32::Foundation::RECT::default();
        unsafe {
            GetWindowRect(self.hwnd(), &mut rect).map_err(|e| e.to_string())?;
        }
        self.move_pointer((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)?
            .scroll(amount.clamp(-12, 12), enigo::Axis::Vertical)
            .map_err(|e| e.to_string())
    }

    pub fn resolve_apps(&self, query: &str) -> Result<Vec<AppCandidate>, String> {
        let running: Vec<_> = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|w| w.pid().ok() != Some(std::process::id()) && w.title().is_ok_and(|s| !s.is_empty()))
            .filter_map(|w| window_identity(w.id().ok()?).ok())
            .collect();
        let mut apps: Vec<AppCandidate> = vec![];
        for (name, path) in &self.apps {
            let executable = shortcut_executable(path);
            if apps
                .iter()
                .any(|a| a.name.eq_ignore_ascii_case(name) && a.executable.is_some() && a.executable == executable)
            {
                continue;
            }
            let mut candidate = AppCandidate {
                id: crate::ids::new_id(),
                name: name.clone(),
                launch_path: Some(path.clone()),
                executable,
                windows: vec![],
            };
            candidate.windows = running
                .iter()
                .filter(|w| window_matches_app(&candidate, w))
                .cloned()
                .collect();
            apps.push(candidate);
        }
        for (name, exe) in [
            ("Notepad", "notepad.exe"),
            ("Calculator", "calc.exe"),
            ("File Explorer", "explorer.exe"),
            ("Chrome", "chrome.exe"),
        ] {
            if !apps.iter().any(|a| app_name(&a.name) == app_name(name)) {
                apps.push(AppCandidate {
                    id: crate::ids::new_id(),
                    name: name.into(),
                    launch_path: Some(exe.into()),
                    executable: Some(exe.into()),
                    windows: running
                        .iter()
                        .filter(|w| app_name(&w.app) == app_name(name))
                        .cloned()
                        .collect(),
                });
            }
        }
        for window in running {
            if !apps.iter().any(|a| a.windows.iter().any(|w| w.window == window.window)) {
                apps.push(AppCandidate {
                    id: crate::ids::new_id(),
                    name: window.app.clone(),
                    launch_path: None,
                    executable: None,
                    windows: vec![window],
                });
            }
        }
        Ok(match_apps(query, &apps))
    }

    pub fn activate_app(
        &mut self,
        candidate: &AppCandidate,
        switch_only: bool,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<AppActivation, String> {
        if cancelled() {
            return Err("Task stopped".into());
        }
        launch_allowed(switch_only, candidate.windows.len())?;
        if let Some(window) = candidate.windows.first() {
            validate_identity(window, &window_identity(window.window)?)?;
            self.set_context_target(Some(window.clone()));
            self.focus()?;
            return Ok(AppActivation {
                target: self.target.clone(),
                accepted: true,
                verified: true,
                detail: format!("Switched to {}", candidate.name),
            });
        }
        if app_name(&candidate.name) == "chrome" {
            let id = open_chrome(cancelled)?;
            self.select_target(id)?;
            return Ok(AppActivation {
                target: self.target.clone(),
                accepted: true,
                verified: true,
                detail: "Opened Chrome".into(),
            });
        }
        let path = candidate
            .launch_path
            .as_ref()
            .ok_or("No installed launcher for this app")?;
        shell_open(path.to_str().ok_or("Invalid application path")?)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            if cancelled() {
                return Err("Stopped after Windows accepted the launch; the app may still open.".into());
            }
            if let Ok(Some(window)) = capture_external_target() {
                if window_matches_app(candidate, &window) {
                    self.select_target(window.window)?;
                    return Ok(AppActivation {
                        target: self.target.clone(),
                        accepted: true,
                        verified: true,
                        detail: format!("Opened {}", candidate.name),
                    });
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Ok(AppActivation {
            target: None,
            accepted: true,
            verified: false,
            detail: format!(
                "Windows accepted the launch of {}, but I couldn't verify its window. I won't launch it again.",
                candidate.name
            ),
        })
    }

    pub fn open_app(&mut self, name: &str, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        let candidates = self.resolve_apps(name)?;
        if candidates.len() != 1 {
            return Err("Application not found or ambiguous. Specify its installed name.".into());
        }
        let result = self.activate_app(&candidates[0], false, cancelled)?;
        if result.verified {
            Ok(())
        } else {
            Err(result.detail)
        }
    }

    fn find_folder(&mut self, path: &std::path::Path) -> Result<bool, String> {
        let previous = self.target.clone();
        for window in xcap::Window::all().map_err(|e| e.to_string())? {
            if !window.app_name().is_ok_and(|name| app_name(&name) == "file explorer") {
                continue;
            }
            let Ok(id) = window.id() else {
                continue;
            };
            if self.select_target(id).is_err() {
                continue;
            }
            if self
                .explorer_context()
                .ok()
                .and_then(|c| c.folder)
                .is_some_and(|folder| paths_equal(path, &folder))
            {
                return Ok(true);
            }
        }
        self.target = previous;
        Ok(false)
    }

    pub fn open_path(&mut self, path: &std::path::Path, cancelled: &dyn Fn() -> bool) -> Result<OpenEvidence, String> {
        use crate::desktop_files::validate_local_path;
        let path = validate_local_path(path)?;
        if cancelled() {
            return Err("Task stopped".into());
        }
        let directory = path.is_dir();
        if directory && self.find_folder(&path)? {
            self.focus()?;
            return Ok(OpenEvidence {
                requested: path.clone(),
                accepted: true,
                verified: true,
                target: self.target.clone(),
                detail: format!("Opened folder {}", path.display()),
            });
        }
        if cancelled() {
            return Err("Task stopped".into());
        }
        shell_open(path.to_str().ok_or("Invalid path encoding")?)?;
        if !directory {
            // Editable field values do not identify the document opened by its associated application.
            return Ok(OpenEvidence::document_accepted(path));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            if cancelled() {
                return Err(
                    "Stopped after Windows accepted the open request; the file or folder may still open.".into(),
                );
            }
            if self.find_folder(&path)? {
                self.focus()?;
                return Ok(OpenEvidence {
                    requested: path.clone(),
                    accepted: true,
                    verified: true,
                    target: self.target.clone(),
                    detail: format!("Opened folder {}", path.display()),
                });
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Ok(OpenEvidence {
            requested: path,
            accepted: true,
            verified: false,
            target: None,
            detail: "Windows accepted the folder request; I couldn't verify the folder opened.".into(),
        })
    }

    pub fn open_url(&self, url: &str) -> Result<(), String> {
        validate_url(url)?;
        launch_chrome(url)
    }

    pub fn screenshot(&self) -> Result<String, String> {
        let window = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id().ok() == self.target_id())
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
        self.prepare_input()?;
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

fn shell_item_path(item: &IShellItem) -> Result<PathBuf, String> {
    unsafe {
        let value = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|_| "This Explorer item has no filesystem path.")?;
        let path = value.to_string().map(PathBuf::from).map_err(|e| e.to_string());
        CoTaskMemFree(Some(value.0.cast()));
        path
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
    #[test]
    fn pinned_input_rejects_a_foreground_change() {
        let target = identity(10, 20, 30);
        assert!(validate_input_target(&target, &target, 10, 20).is_ok());
        assert!(validate_input_target(&target, &target, 11, 21).is_err());
        assert!(validate_input_target(&target, &target, 11, std::process::id()).is_ok());
        assert!(validate_input_target(&target, &identity(10, 21, 31), 10, 21).is_err());
    }
    #[test]
    fn observed_focus_rejects_reused_handles() {
        let original = identity(10, 20, 30);
        assert!(listed_identity(std::slice::from_ref(&original), &identity(10, 21, 31)).is_err());
        assert!(listed_identity(std::slice::from_ref(&original), &identity(11, 20, 30)).is_err());
        assert_eq!(
            listed_identity(std::slice::from_ref(&original), &original).unwrap().pid,
            20
        );
    }

    #[test]
    fn generic_document_dispatch_cannot_be_verified_by_foreground_text() {
        let evidence = OpenEvidence::document_accepted(PathBuf::from(r"C:\docs\budget.xlsx"));
        assert!(evidence.accepted);
        assert!(!evidence.verified);
        assert!(evidence.target.is_none());
        assert!(evidence.require_verified().is_err());
    }
    #[test]
    fn chrome_context_rejects_other_tabs_and_ambiguous_windows() {
        assert!(chrome_page_matches("Report", "Report - Google Chrome", 1));
        assert!(!chrome_page_matches("Other", "Report - Google Chrome", 1));
        assert!(!chrome_page_matches("Report", "Report - Google Chrome", 2));
        assert!(!chrome_page_matches("", "Report - Google Chrome", 1));
    }
    use super::*;
    #[test]
    fn path_verification_needs_exact_directory_not_a_shared_basename() {
        assert!(paths_equal(
            std::path::Path::new(r"C:\One\Projects"),
            std::path::Path::new(r"\\?\C:\one\Projects")
        ));
        assert!(!paths_equal(
            std::path::Path::new(r"C:\One\Projects"),
            std::path::Path::new(r"C:\Two\Projects")
        ));
        let evidence = OpenEvidence {
            requested: "C:/report.pdf".into(),
            accepted: true,
            verified: false,
            target: None,
            detail: "accepted".into(),
        };
        assert!(evidence.require_verified().is_err());
    }
    #[test]
    fn app_aliases_and_duplicate_names_preserve_real_choices() {
        assert_eq!(app_name("Windows Explorer"), "file explorer");
        let apps = vec![
            AppCandidate {
                id: "a".into(),
                name: "Visual Studio Code".into(),
                launch_path: Some("C:/A/Code.lnk".into()),
                executable: Some("C:/A/Code.exe".into()),
                windows: vec![],
            },
            AppCandidate {
                id: "b".into(),
                name: "Visual Studio Code".into(),
                launch_path: Some("C:/B/Code.lnk".into()),
                executable: Some("C:/B/Code.exe".into()),
                windows: vec![],
            },
        ];
        assert_eq!(match_apps("  VS   Code  ", &apps).len(), 2);
        assert_eq!(match_apps("visual studio code", &apps).len(), 2);
        assert!(match_apps("studioX", &apps).is_empty());
        assert!(launch_allowed(true, 0).is_err());
        assert!(launch_allowed(false, 0).is_ok());
        assert!(launch_allowed(false, 2).is_err());
    }

    #[test]
    fn app_matching_does_not_confuse_executables_with_the_same_name() {
        let candidate = AppCandidate {
            id: "a".into(),
            name: "Code".into(),
            launch_path: None,
            executable: Some(r"C:\Trusted\Code.exe".into()),
            windows: vec![],
        };
        let mut window = identity(1, 2, 3);
        window.app = "Code".into();
        window.executable = r"C:\Other\Code.exe".into();
        assert!(!window_matches_app(&candidate, &window));
        window.executable = r"C:\Trusted\Code.exe".into();
        assert!(window_matches_app(&candidate, &window));
    }

    #[test]
    #[ignore = "Reads Explorer context locally without input or network"]
    fn live_explorer_context_probe() {
        let mut desktop = Desktop::new().unwrap();
        for window in xcap::Window::all().unwrap() {
            let Ok(identity) = window_identity(window.id().unwrap()) else {
                continue;
            };
            if identity.app.eq_ignore_ascii_case("explorer") {
                eprintln!("Explorer app label: {:?}", window.app_name());
                desktop.select_target(identity.window).unwrap();
                match desktop.explorer_context() {
                    Ok(context) => eprintln!(
                        "Explorer native folder={}, selected={}",
                        context.folder.is_some(),
                        context.selected.len()
                    ),
                    Err(error) => eprintln!("Explorer context error: {error}"),
                }
            }
        }
    }
    #[test]
    #[ignore = "Opens a synthetic local folder in Explorer ten times to verify native folder identity and reuse"]
    fn live_folder_open_verifies_exact_path() {
        let root = std::env::temp_dir().join(format!("Synapse acceptance {}", crate::ids::new_id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut desktop = Desktop::new().unwrap();
        let mut first = None;
        for _ in 0..10 {
            let result = desktop.open_path(&root, &|| false).unwrap();
            if !result.verified {
                for window in xcap::Window::all().unwrap() {
                    if window.app_name().is_ok_and(|name| app_name(&name) == "file explorer") {
                        desktop.select_target(window.id().unwrap()).unwrap();
                        match desktop.explorer_context() {
                            Ok(context) => eprintln!(
                                "Explorer probe: folder available={}, requested folder={}, selected={}",
                                context.folder.is_some(),
                                context.folder.is_some_and(|p| paths_equal(&p, &root)),
                                context.selected.len()
                            ),
                            Err(error) => eprintln!("Explorer probe error: {error}"),
                        }
                    }
                }
            }
            assert!(result.verified, "{}", result.detail);
            let id = result.target.unwrap().window;
            if let Some(first) = first {
                assert_eq!(first, id, "Reuse the exact folder window");
            } else {
                first = Some(id);
            }
        }
        std::fs::remove_dir(&root).unwrap();
    }
    fn identity(window: u32, pid: u32, started: u64) -> WindowIdentity {
        WindowIdentity {
            window,
            pid,
            process_started_at: started,
            app: "Notepad".into(),
            title: "Draft".into(),
            observed_at_ms: 0,
            executable: r"C:\Windows\Notepad.exe".into(),
        }
    }
    #[test]
    fn desktop_target_reuse_is_rejected() {
        let original = identity(1, 2, 3);
        assert!(validate_identity(&original, &identity(1, 4, 3)).is_err());
        assert!(validate_identity(&original, &identity(1, 2, 4)).is_err());
        assert!(validate_identity(&original, &identity(2, 2, 3)).is_err());
    }
    #[test]
    fn desktop_missing_target_does_not_pick_first_window() {
        assert!(observed_identity(None, &[identity(1, 2, 3)]).is_err());
        assert!(observed_identity(Some(&identity(4, 2, 3)), &[identity(1, 2, 3)]).is_err());
    }
    #[test]
    fn desktop_title_change_requires_fresh_observation() {
        let original = identity(1, 2, 3);
        let mut changed = original.clone();
        changed.title = "Other document".into();
        assert!(validate_identity(&original, &changed).is_ok());
        assert!(!same_observation(&original, &changed));
        assert!(same_observation(&changed, &changed));
    }
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
