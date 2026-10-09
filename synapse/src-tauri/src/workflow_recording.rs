//! Local, explicitly scoped Teach Synapse recording. Captured input is always a placeholder.
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::time::Duration;
use tauri::{Emitter, Manager};

const LIMIT: usize = 1000;
static NEXT: AtomicU64 = AtomicU64::new(1 << 48);
static RECORDING: OnceLock<Mutex<Option<Arc<Recording>>>> = OnceLock::new();

struct Recording {
    id: String,
    source: String,
    target: String,
    generation: u64,
    paused: AtomicBool,
    stopped: AtomicBool,
    steps: Mutex<Vec<Value>>,
    error: Mutex<String>,
    io: Mutex<()>,
    desktop: Mutex<Option<mpsc::Sender<DesktopControl>>>,
}
enum DesktopControl {
    Pause(bool, mpsc::Sender<Result<(), String>>),
    Stop(mpsc::Sender<()>),
}
fn slot() -> &'static Mutex<Option<Arc<Recording>>> {
    RECORDING.get_or_init(|| Mutex::new(None))
}
fn session(id: &str) -> Result<Arc<Recording>, String> {
    slot()
        .lock()
        .map_err(|_| "Recording unavailable")?
        .as_ref()
        .filter(|r| r.id == id)
        .cloned()
        .ok_or("Recording is no longer active".into())
}
fn snapshot(recording: &Recording) -> Value {
    json!({"id":recording.id,"source":recording.source,"target":recording.target,
        "paused":recording.paused.load(Ordering::SeqCst),"stopped":recording.stopped.load(Ordering::SeqCst),"steps":recording.steps.lock().map(|s|s.clone()).unwrap_or_default(),
        "error":recording.error.lock().map(|s|s.clone()).unwrap_or_else(|_|"Recording unavailable".into())})
}
fn emit(app: &tauri::AppHandle, recording: &Recording) {
    let _ = app.emit("workflow-recording", snapshot(recording));
}
fn error(recording: &Recording, message: impl Into<String>) {
    if let Ok(mut error) = recording.error.lock() {
        *error = message.into();
    }
}
fn protected(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "password",
        "passcode",
        "credit card",
        "card number",
        "cvv",
        "cvc",
        "payment",
        "captcha",
        "token",
        "secret",
        "security",
        "authenticat",
        "sign in",
        "log in",
        "one-time",
        "otp",
        "cc-",
    ]
    .iter()
    .any(|word| lower.contains(word))
}
fn append(recording: &Recording, mut step: Value) {
    if recording.stopped.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(mut steps) = recording.steps.lock() {
        if steps.len() >= LIMIT {
            error(recording, "Recording reached 1,000 steps. Stop and review the draft.");
            if let Some(last) = steps.last_mut() {
                last["unresolved"] =
                    json!("Recording reached 1,000 steps and is incomplete. Review the draft before running it.");
            }
            recording.paused.store(true, Ordering::SeqCst);
            return;
        }
        // Consecutive value-change notifications describe one edit, never its contents.
        if step["recorded"]["operation"] == "fill"
            && steps.last().is_some_and(|last| last["recorded"] == step["recorded"])
        {
            return;
        }
        step["id"] = json!(format!("recorded-{}-{}", recording.generation, steps.len() + 1));
        step["timeout_secs"] = json!(60);
        steps.push(step);
    }
}
fn browser_event(recording: &Recording, event: Value) -> Result<(), String> {
    let operation = event["operation"]
        .as_str()
        .ok_or("Missing recorded operation")?
        .to_owned();
    if operation == "navigate" {
        let url = event["url"].as_str().ok_or("Missing recorded URL")?;
        let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid recorded URL")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
        {
            return Err("Unsafe recorded URL".into());
        }
        let unresolved = if event["omittedQuery"] == true {
            "URL parameters or a fragment were omitted for privacy. Supply the intended URL before replay."
        } else {
            ""
        };
        append(
            recording,
            json!({"kind":"open_url","url":url,"label":"Open recorded page","expected":"","unresolved":unresolved}),
        );
        return Ok(());
    }
    if !["click", "fill", "select", "press_key"].contains(&operation.as_str()) {
        return Err("Unsupported browser recording event".into());
    }
    let name = event["target"]["name"].as_str().unwrap_or("");
    if protected(name) {
        return Ok(());
    }
    let name = if name.is_empty() {
        event["target"]["role"].as_str().unwrap_or("control")
    } else {
        name
    };
    let label = format!("{operation}: {}", name.chars().take(180).collect::<String>());
    let mut recorded = event;
    if let Some(object) = recorded.as_object_mut() {
        object.remove("frameUrl");
    }
    let unresolved = if ["fill", "select"].contains(&operation.as_str()) {
        recorded["textValue"] = json!("{{input}}");
        "Supply the input for this step; recorded field values are never stored."
    } else {
        ""
    };
    append(
        recording,
        json!({"kind":"browser","instruction":label,"label":label,"expected":"","recorded":recorded,"unresolved":unresolved}),
    );
    Ok(())
}
fn ingest_browser(recording: &Recording, response: Value) -> Result<usize, String> {
    if let Some(message) = response["error"].as_str().filter(|s| !s.is_empty()) {
        error(recording, message);
    }
    if response["paused"] == true {
        recording.paused.store(true, Ordering::SeqCst);
    }
    let events = response["events"].as_array().cloned().unwrap_or_default();
    for event in events {
        browser_event(recording, event)?;
    }
    Ok(response["remaining"].as_u64().unwrap_or(0) as usize)
}

pub fn status(_app: &tauri::AppHandle) -> Result<Value, String> {
    Ok(slot()
        .lock()
        .map_err(|_| "Recording unavailable")?
        .as_ref()
        .map(|r| snapshot(r))
        .unwrap_or(Value::Null))
}
pub fn targets(app: &tauri::AppHandle, source: &str) -> Result<Vec<Value>, String> {
    match source {
        "browser" => {
            let bridge = app.state::<Arc<crate::browser::Bridge>>();
            let response = bridge.command(
                NEXT.fetch_add(1, Ordering::SeqCst),
                "record_targets",
                json!({}),
                None,
                &|| false,
            )?;
            Ok(response["targets"].as_array().cloned().unwrap_or_default())
        }
        "desktop" => native::targets(),
        _ => Err("Choose browser or desktop recording".into()),
    }
}
pub fn start(app: &tauri::AppHandle, source: &str, target: &str) -> Result<Value, String> {
    if !["browser", "desktop"].contains(&source) {
        return Err("Choose browser or desktop recording".into());
    }
    let generation = NEXT.fetch_add(1, Ordering::SeqCst);
    let recording = Arc::new(Recording {
        id: format!("recording-{generation}"),
        source: source.into(),
        target: target.into(),
        generation,
        paused: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        steps: Mutex::new(vec![]),
        error: Mutex::new(String::new()),
        io: Mutex::new(()),
        desktop: Mutex::new(None),
    });
    {
        let mut slot = slot().lock().map_err(|_| "Recording unavailable")?;
        if slot.is_some() {
            return Err("Stop the current recording first".into());
        }
        *slot = Some(recording.clone());
    }
    let setup = (|| {
        if source == "browser" {
            if !crate::settings::load(&crate::settings_path(app)?).ai.browser_control {
                return Err("Enable Chrome control before recording".into());
            }
            let tab = target.parse::<u64>().map_err(|_| "Select a Chrome tab")?;
            let bridge = app.state::<Arc<crate::browser::Bridge>>();
            let version = bridge.command(generation, "get_version", json!({}), None, &|| false)?;
            if version["build"] != "0.1.5" {
                return Err("Reload the Chrome companion before recording (version 0.1.5 required)".into());
            }
            let response = bridge.command(generation, "record_start", json!({"tab":tab}), None, &|| false)?;
            ingest_browser(&recording, response)?;
            let app = app.clone();
            let worker = recording.clone();
            std::thread::spawn(move || {
                while !worker.stopped.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(500));
                    let Ok(_io) = worker.io.lock() else { break };
                    if worker.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    let result = app
                        .state::<Arc<crate::browser::Bridge>>()
                        .command(worker.generation, "record_read", json!({}), None, &|| false)
                        .and_then(|response| ingest_browser(&worker, response));
                    if let Err(message) = result {
                        error(&worker, message);
                        worker.paused.store(true, Ordering::SeqCst);
                        app.state::<Arc<crate::browser::Bridge>>().stop(worker.generation);
                        emit(&app, &worker);
                        break;
                    }
                    emit(&app, &worker);
                }
            });
        } else {
            native::start(app, recording.clone())?;
        }
        Ok(())
    })();
    if let Err(message) = setup {
        recording.stopped.store(true, Ordering::SeqCst);
        if source == "browser" {
            app.state::<Arc<crate::browser::Bridge>>().stop(generation);
        }
        if let Ok(mut slot) = slot().lock() {
            *slot = None;
        }
        return Err(message);
    }
    emit(app, &recording);
    Ok(snapshot(&recording))
}
pub fn pause(app: &tauri::AppHandle, id: &str, paused: bool) -> Result<Value, String> {
    let recording = session(id)?;
    let _io = recording.io.lock().map_err(|_| "Recording unavailable")?;
    if recording.source == "browser" {
        let response = app.state::<Arc<crate::browser::Bridge>>().command(
            recording.generation,
            "record_pause",
            json!({"paused":paused}),
            None,
            &|| false,
        )?;
        ingest_browser(&recording, response)?;
    } else {
        let (send, receive) = mpsc::channel();
        recording
            .desktop
            .lock()
            .map_err(|_| "Recording unavailable")?
            .as_ref()
            .ok_or("Desktop recorder stopped")?
            .send(DesktopControl::Pause(paused, send))
            .map_err(|_| "Desktop recorder stopped")?;
        receive
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Desktop recorder did not acknowledge pause")??;
    }
    recording.paused.store(paused, Ordering::SeqCst);
    emit(app, &recording);
    Ok(snapshot(&recording))
}
pub fn stop(app: &tauri::AppHandle, id: &str) -> Result<Vec<Value>, String> {
    let recording = session(id)?;
    let _io = recording.io.lock().map_err(|_| "Recording unavailable")?;
    recording.paused.store(true, Ordering::SeqCst);
    if recording.source == "browser" {
        let bridge = app.state::<Arc<crate::browser::Bridge>>();
        let drain = (|| {
            bridge.command(
                recording.generation,
                "record_pause",
                json!({"paused":true}),
                None,
                &|| false,
            )?;
            for _ in 0..26 {
                let response = bridge.command(recording.generation, "record_read", json!({}), None, &|| false)?;
                if ingest_browser(&recording, response)? == 0 {
                    break;
                }
            }
            ingest_browser(
                &recording,
                bridge.command(recording.generation, "record_stop", json!({}), None, &|| false)?,
            )?;
            Ok::<(), String>(())
        })();
        if let Err(message) = drain {
            error(&recording, message);
            bridge.stop(recording.generation);
        }
    } else if let Some(control) = recording.desktop.lock().map_err(|_| "Recording unavailable")?.as_ref() {
        let (send, receive) = mpsc::channel();
        let _ = control.send(DesktopControl::Stop(send));
        if receive.recv_timeout(Duration::from_secs(5)).is_err() {
            error(
                &recording,
                "Desktop recorder cleanup timed out; draft may be incomplete",
            );
        }
    }
    let message = recording.error.lock().map(|s| s.clone()).unwrap_or_default();
    if !message.is_empty() {
        append(
            &recording,
            json!({"kind":recording.source,"label":"Review recording interruption","instruction":"Repair this recording before running it","expected":"","unresolved":message}),
        );
    }
    recording.stopped.store(true, Ordering::SeqCst);
    let steps = recording.steps.lock().map_err(|_| "Recording unavailable")?.clone();
    emit(app, &recording);
    let mut slot = slot().lock().map_err(|_| "Recording unavailable")?;
    if slot.as_ref().is_some_and(|r| r.id == id) {
        *slot = None;
    }
    Ok(steps)
}

pub fn replay_browser(
    app: &tauri::AppHandle,
    generation: u64,
    recorded: &Value,
    cancelled: &dyn Fn() -> bool,
    approve: &mut dyn FnMut(&str) -> Result<bool, String>,
) -> Result<String, String> {
    let bridge = app.state::<Arc<crate::browser::Bridge>>();
    if cancelled() {
        return Err("Workflow stopped".into());
    }
    let result = (|| {
        bridge.command(generation, "begin_task", json!({"current":true}), None, cancelled)?;
        let resolved = bridge.command(
            generation,
            "resolve_recorded",
            json!({"recorded":recorded}),
            None,
            cancelled,
        )?;
        let command = resolved["command"].as_str().ok_or("Invalid resolved recording")?;
        let params = resolved["params"].clone();
        let review = bridge.command(
            generation,
            "prepare",
            json!({"command":command,"params":params}),
            None,
            cancelled,
        )?;
        let approval = if review["reviewRequired"] == true {
            if !approve(review["description"].as_str().unwrap_or("Run recorded browser action"))? {
                return Err("Recorded action declined".into());
            }
            review["reviewId"].as_str()
        } else {
            None
        };
        let outcome = bridge.command(generation, command, params, approval, cancelled)?;
        Ok(format!("Recorded browser action completed: {outcome}"))
    })();
    bridge.stop(generation);
    result
}
pub fn replay_desktop(
    app: &tauri::AppHandle,
    generation: u64,
    recorded: &Value,
    cancelled: &dyn Fn() -> bool,
    approve: &mut dyn FnMut(&str) -> Result<bool, String>,
) -> Result<String, String> {
    let _ = (app, generation);
    native::replay(recorded, cancelled, approve)
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub(super) fn targets() -> Result<Vec<Value>, String> {
        Err("Desktop recording requires Windows".into())
    }
    pub(super) fn start(_: &tauri::AppHandle, _: Arc<Recording>) -> Result<(), String> {
        Err("Desktop recording requires Windows".into())
    }
    pub(super) fn replay(
        _: &Value,
        _: &dyn Fn() -> bool,
        _: &mut dyn FnMut(&str) -> Result<bool, String>,
    ) -> Result<String, String> {
        Err("Desktop recording requires Windows".into())
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows::{
        core::{implement, Interface, Ref, BSTR},
        Win32::{
            Foundation::HWND,
            System::{Com::*, Variant::VARIANT},
            UI::{Accessibility::*, WindowsAndMessaging::*},
        },
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    fn automation() -> Result<(Apartment, IUIAutomation), String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
            let apartment = Apartment;
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            if let Ok(v2) = automation.cast::<IUIAutomation2>() {
                let _ = v2.SetConnectionTimeout(1500);
                let _ = v2.SetTransactionTimeout(1500);
            }
            Ok((apartment, automation))
        }
    }
    pub(super) fn targets() -> Result<Vec<Value>, String> {
        Ok(xcap::Window::all().map_err(|e|e.to_string())?.into_iter().filter(|w|w.pid().ok()!=Some(std::process::id()) && w.title().is_ok_and(|s|!s.is_empty())).take(100)
            .filter_map(|w|Some(json!({"id":w.id().ok()?.to_string(),"name":format!("{} — {}",w.app_name().ok()?,w.title().ok()?).chars().take(240).collect::<String>()}))).collect())
    }
    fn descriptor(element: &IUIAutomationElement) -> Result<Value, String> {
        unsafe {
            if element.CurrentIsPassword().map_err(|e| e.to_string())?.as_bool() {
                return Err("Protected control".into());
            }
            let name = element.CurrentName().map_err(|e| e.to_string())?.to_string();
            let id = element.CurrentAutomationId().map_err(|e| e.to_string())?.to_string();
            if protected(&format!("{name} {id}")) {
                return Err("Protected control".into());
            }
            let kind = element.CurrentControlType().map_err(|e| e.to_string())?;
            let editable = [
                UIA_EditControlTypeId,
                UIA_DocumentControlTypeId,
                UIA_ComboBoxControlTypeId,
            ]
            .contains(&kind);
            // Editable UIA names can contain the document's contents; only AutomationId may identify them.
            let name = if editable {
                String::new()
            } else {
                name.chars().take(180).collect()
            };
            if id.is_empty() && name.is_empty() {
                return Err("This control has no stable accessible identity; add a manual step".into());
            }
            Ok(
                json!({"automationId":id.chars().take(180).collect::<String>(),"name":name,"controlType":kind.0,
                "className":element.CurrentClassName().map_err(|e|e.to_string())?.to_string().chars().take(180).collect::<String>()}),
            )
        }
    }
    struct Capture {
        recording: Arc<Recording>,
        pid: u32,
        hwnd: usize,
        app: String,
        title: String,
        events: mpsc::SyncSender<Value>,
    }
    impl Capture {
        fn capture(&self, element: Option<&IUIAutomationElement>, operation: &str) {
            let r = &self.recording;
            if r.paused.load(Ordering::SeqCst) || r.stopped.load(Ordering::SeqCst) {
                return;
            }
            let Some(element) = element else { return };
            unsafe {
                if GetForegroundWindow().0 as usize != self.hwnd
                    || element.CurrentProcessId().ok() != Some(self.pid as i32)
                    || element.CurrentIsOffscreen().is_ok_and(|v| v.as_bool())
                {
                    return;
                }
            }
            let target = match descriptor(element) {
                Ok(target) => target,
                Err(message) => {
                    if message != "Protected control" {
                        error(r, message);
                    }
                    return;
                }
            };
            let supported = unsafe {
                match operation {
                    "invoke" => element
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .is_ok(),
                    "select" => element
                        .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                        .is_ok(),
                    "toggle" => element
                        .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                        .is_ok(),
                    "fill" => element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .is_ok(),
                    _ => false,
                }
            };
            let mut recorded =
                json!({"operation":operation,"target":{"app":self.app,"windowTitle":self.title,"control":target}});
            if operation == "fill" {
                recorded["textValue"] = json!("{{input}}");
            }
            if operation == "toggle" {
                let state = unsafe {
                    element
                        .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                        .and_then(|p| p.CurrentToggleState())
                };
                if let Ok(state) = state {
                    recorded["toggleState"] = json!(state.0);
                } else {
                    return;
                }
            }
            let unresolved = if !supported {
                "This provider does not expose a supported action pattern. Replace this with a manual step."
            } else if operation == "fill" {
                "Supply the input for this step; recorded values are never stored."
            } else {
                ""
            };
            let label = format!(
                "{operation}: {}",
                target["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(target["automationId"].as_str().unwrap_or("control"))
            );
            let step = json!({"kind":"desktop","label":label,"instruction":label,"expected":"","recorded":recorded,"unresolved":unresolved});
            if self.events.try_send(step).is_err() {
                error(r, "Desktop recording queue filled. Stop and review the draft.");
                r.paused.store(true, Ordering::SeqCst);
            }
        }
    }
    #[implement(IUIAutomationEventHandler)]
    struct Events(Arc<Capture>);
    impl IUIAutomationEventHandler_Impl for Events_Impl {
        fn HandleAutomationEvent(
            &self,
            sender: Ref<IUIAutomationElement>,
            eventid: UIA_EVENT_ID,
        ) -> windows::core::Result<()> {
            let operation = if eventid == UIA_Invoke_InvokedEventId {
                "invoke"
            } else if eventid == UIA_SelectionItem_ElementSelectedEventId {
                "select"
            } else {
                "fill"
            };
            self.0.capture(sender.as_ref(), operation);
            Ok(())
        }
    }
    #[implement(IUIAutomationPropertyChangedEventHandler)]
    struct Properties(Arc<Capture>);
    impl IUIAutomationPropertyChangedEventHandler_Impl for Properties_Impl {
        fn HandlePropertyChangedEvent(
            &self,
            sender: Ref<IUIAutomationElement>,
            propertyid: UIA_PROPERTY_ID,
            _newvalue: &VARIANT,
        ) -> windows::core::Result<()> {
            self.0.capture(
                sender.as_ref(),
                if propertyid == UIA_ToggleToggleStatePropertyId {
                    "toggle"
                } else {
                    "fill"
                },
            );
            Ok(())
        }
    }
    fn subscribe(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
        events: &IUIAutomationEventHandler,
        properties: &IUIAutomationPropertyChangedEventHandler,
    ) -> Result<(), String> {
        unsafe {
            for event in [
                UIA_Invoke_InvokedEventId,
                UIA_SelectionItem_ElementSelectedEventId,
                UIA_Text_TextChangedEventId,
            ] {
                automation
                    .AddAutomationEventHandler(event, root, TreeScope_Subtree, None, events)
                    .map_err(|e| e.to_string())?;
            }
            automation
                .AddPropertyChangedEventHandlerNativeArray(
                    root,
                    TreeScope_Subtree,
                    None,
                    properties,
                    &[UIA_ValueValuePropertyId, UIA_ToggleToggleStatePropertyId],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(super) fn start(app: &tauri::AppHandle, recording: Arc<Recording>) -> Result<(), String> {
        let app = app.clone();
        start_worker(recording, move |recording| emit(&app, recording))
    }
    fn start_worker(recording: Arc<Recording>, publish: impl Fn(&Recording) + Send + 'static) -> Result<(), String> {
        let hwnd = recording
            .target
            .parse::<u32>()
            .map_err(|_| "Select an application window")?;
        let selected = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id().ok() == Some(hwnd))
            .ok_or("Selected window is no longer available")?;
        let pid = selected.pid().map_err(|e| e.to_string())?;
        if pid == std::process::id() {
            return Err("Synapse cannot record itself".into());
        }
        let app_name = selected.app_name().map_err(|e| e.to_string())?;
        let title = selected.title().map_err(|e| e.to_string())?;
        let (control, controls) = mpsc::channel();
        *recording.desktop.lock().map_err(|_| "Recording unavailable")? = Some(control);
        let (ready, result) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = (|| -> Result<(), String> {
                let (_apartment, automation) = automation()?;
                let root = unsafe { automation.ElementFromHandle(HWND(hwnd as usize as *mut _)) }
                    .map_err(|e| e.to_string())?;
                let (events_send, events_receive) = mpsc::sync_channel(256);
                let capture = Arc::new(Capture {
                    recording: recording.clone(),
                    pid,
                    hwnd: hwnd as usize,
                    app: app_name,
                    title,
                    events: events_send,
                });
                let events: IUIAutomationEventHandler = Events(capture.clone()).into();
                let properties: IUIAutomationPropertyChangedEventHandler = Properties(capture).into();
                if let Err(message) = subscribe(&automation, &root, &events, &properties) {
                    unsafe {
                        let _ = automation.RemoveAllEventHandlers();
                    }
                    return Err(message);
                }
                let _ = ready.send(Ok(()));
                let mut last_emit = std::time::Instant::now();
                loop {
                    match controls.recv_timeout(Duration::from_millis(100)) {
                        Ok(DesktopControl::Pause(paused, reply)) => {
                            recording.paused.store(true, Ordering::SeqCst);
                            let stopped = unsafe { automation.RemoveAllEventHandlers() }.map_err(|e| e.to_string());
                            let outcome = stopped.and_then(|_| {
                                if paused {
                                    Ok(())
                                } else {
                                    subscribe(&automation, &root, &events, &properties)
                                }
                            });
                            if outcome.is_ok() {
                                recording.paused.store(paused, Ordering::SeqCst);
                            }
                            let _ = reply.send(outcome);
                        }
                        Ok(DesktopControl::Stop(reply)) => {
                            recording.paused.store(true, Ordering::SeqCst);
                            unsafe {
                                let _ = automation.RemoveAllEventHandlers();
                            }
                            for step in events_receive.try_iter() {
                                append(&recording, step);
                            }
                            let _ = reply.send(());
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            unsafe {
                                let _ = automation.RemoveAllEventHandlers();
                            }
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    for step in events_receive.try_iter() {
                        append(&recording, step);
                    }
                    if !unsafe { IsWindow(Some(HWND(hwnd as usize as *mut _))) }.as_bool() {
                        error(&recording, "Selected window closed. Stop and review the draft.");
                        recording.paused.store(true, Ordering::SeqCst);
                        unsafe {
                            let _ = automation.RemoveAllEventHandlers();
                        }
                    }
                    if last_emit.elapsed() >= Duration::from_millis(500) {
                        publish(&recording);
                        last_emit = std::time::Instant::now();
                    }
                    if recording.stopped.load(Ordering::SeqCst) {
                        unsafe {
                            let _ = automation.RemoveAllEventHandlers();
                        }
                        break;
                    }
                }
                Ok(())
            })();
            if let Err(message) = outcome {
                let _ = ready.send(Err(message.clone()));
                error(&recording, message);
                recording.paused.store(true, Ordering::SeqCst);
                publish(&recording);
            }
        });
        result
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Windows did not initialize recording in time")?
    }
    fn find(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
        target: &Value,
    ) -> Result<IUIAutomationElement, String> {
        let walker = unsafe { automation.ControlViewWalker() }.map_err(|e| e.to_string())?;
        let mut queue = std::collections::VecDeque::from([root.clone()]);
        let mut matches = vec![];
        let mut visited = 0;
        let start = std::time::Instant::now();
        while let Some(element) = queue.pop_front() {
            visited += 1;
            if visited > 2000 || start.elapsed() > Duration::from_secs(3) {
                return Err("Application tree is too large to resolve this recording safely".into());
            }
            if descriptor(&element).is_ok_and(|value| value == *target) {
                matches.push(element.clone());
                if matches.len() > 1 {
                    return Err("Recorded desktop target is ambiguous".into());
                }
            }
            unsafe {
                if let Ok(mut child) = walker.GetFirstChildElement(&element) {
                    for _ in 0..500 {
                        queue.push_back(child.clone());
                        let Ok(next) = walker.GetNextSiblingElement(&child) else {
                            break;
                        };
                        child = next;
                    }
                }
            }
        }
        matches
            .pop()
            .ok_or("Recorded desktop target is missing; repair this step".into())
    }
    pub(super) fn replay(
        recorded: &Value,
        cancelled: &dyn Fn() -> bool,
        approve: &mut dyn FnMut(&str) -> Result<bool, String>,
    ) -> Result<String, String> {
        if cancelled() {
            return Err("Workflow stopped".into());
        }
        let operation = recorded["operation"].as_str().ok_or("Missing recorded operation")?;
        if !["invoke", "select", "toggle", "fill"].contains(&operation) {
            return Err("Unsupported recorded desktop operation".into());
        }
        let target = &recorded["target"];
        let app = target["app"].as_str().ok_or("Missing recorded application")?;
        let title = target["windowTitle"].as_str().ok_or("Missing recorded window")?;
        let windows = xcap::Window::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|w| {
                w.pid().ok() != Some(std::process::id())
                    && w.app_name().ok().as_deref() == Some(app)
                    && w.title().ok().as_deref() == Some(title)
            })
            .collect::<Vec<_>>();
        if windows.len() != 1 {
            return Err("Select one uniquely matching recorded application window before replay".into());
        }
        let hwnd = HWND(windows[0].id().map_err(|e| e.to_string())? as usize as *mut _);
        let (_apartment, automation) = automation()?;
        let root = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|e| e.to_string())?;
        let element = find(&automation, &root, &target["control"])?;
        let identity = descriptor(&element)?;
        if !unsafe { element.CurrentIsEnabled() }
            .map_err(|e| e.to_string())?
            .as_bool()
        {
            return Err("Recorded desktop control is disabled".into());
        }
        let text = recorded["textValue"].as_str().unwrap_or("");
        if operation == "fill" && (text.is_empty() || text.contains("{{input}}") || text.len() > 10000) {
            return Err("Supply this recorded step's input before replay".into());
        }
        // UIA cannot infer consequences. Every non-text recorded native action is reviewed.
        if operation != "fill"
            && !approve(&format!(
                "{operation} {} in {app}",
                identity["name"].as_str().unwrap_or("recorded control")
            ))?
        {
            return Err("Recorded desktop action declined".into());
        }
        if cancelled() {
            return Err("Workflow stopped".into());
        }
        let fresh = find(&automation, &root, &target["control"])?;
        if descriptor(&fresh)? != identity {
            return Err("Recorded target changed during confirmation".into());
        }
        unsafe {
            let _ = SetForegroundWindow(hwnd);
            if GetForegroundWindow() != hwnd {
                return Err("Windows blocked application focus; select it and retry".into());
            }
            if cancelled() {
                return Err("Workflow stopped".into());
            }
            match operation {
                "invoke" => fresh
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .and_then(|p| p.Invoke()),
                "select" => fresh
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                    .and_then(|p| p.Select()),
                "toggle" => {
                    let expected = recorded["toggleState"]
                        .as_i64()
                        .filter(|v| [0, 1, 2].contains(v))
                        .ok_or("Invalid recorded toggle state")?;
                    let pattern = fresh
                        .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                        .map_err(|e| e.to_string())?;
                    for _ in 0..3 {
                        if cancelled() {
                            return Err("Workflow stopped".into());
                        }
                        if pattern.CurrentToggleState().map_err(|e| e.to_string())?.0 as i64 == expected {
                            break;
                        }
                        if cancelled() {
                            return Err("Workflow stopped".into());
                        }
                        pattern.Toggle().map_err(|e| e.to_string())?;
                    }
                    if pattern.CurrentToggleState().map_err(|e| e.to_string())?.0 as i64 != expected {
                        return Err("Toggle did not reach its recorded state".into());
                    }
                    Ok(())
                }
                "fill" => {
                    let pattern = fresh
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .map_err(|e| e.to_string())?;
                    if pattern.CurrentIsReadOnly().map_err(|e| e.to_string())?.as_bool() {
                        return Err("Recorded field is read-only".into());
                    }
                    pattern.SetValue(&BSTR::from(text)).map_err(|e| e.to_string())?;
                    if pattern.CurrentValue().map_err(|e| e.to_string())? != text {
                        return Err("Recorded field value did not verify".into());
                    }
                    Ok(())
                }
                _ => unreachable!(),
            }
            .map_err(|e| e.to_string())?;
        }
        if operation == "select"
            && !unsafe {
                fresh
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                    .and_then(|p| p.CurrentIsSelected())
            }
            .map_err(|e| e.to_string())?
            .as_bool()
        {
            return Err("Selection did not verify".into());
        }
        Ok("Recorded desktop control action completed".into())
    }

    #[cfg(test)]
    mod acceptance {
        use super::*;
        use std::{os::windows::process::CommandExt, process::Command, time::Instant};

        struct Fixture(std::process::Child, std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
                let _ = std::fs::remove_file(&self.1);
            }
        }

        #[test]
        #[ignore = "Opens a disposable WPF window and changes desktop focus; run explicitly on Windows"]
        fn windows_recording_native_acceptance() {
            let title = format!("Synapse recording QA {}", std::process::id());
            let path = std::env::temp_dir().join(format!("synapse-recording-qa-{}.ps1", std::process::id()));
            let script = r#"
Add-Type -AssemblyName PresentationFramework
$window = New-Object Windows.Window
$window.Title = '__TITLE__'
$window.Width = 420
$window.Height = 240
$window.Topmost = $true
$panel = New-Object Windows.Controls.StackPanel
$window.Content = $panel
function New-Query {
    $query = New-Object Windows.Controls.TextBox
    [Windows.Automation.AutomationProperties]::SetAutomationId($query, 'Query')
    $query.Margin = '12'
    $query
}
$script:query = New-Query
[void]$panel.Children.Add($script:query)
$button = New-Object Windows.Controls.Button
$button.Content = 'Apply fixture'
[Windows.Automation.AutomationProperties]::SetAutomationId($button, 'Apply')
$button.Add_Click({ $window.Tag = 'applied' })
[void]$panel.Children.Add($button)
$replace = New-Object Windows.Controls.Button
$replace.Content = 'Replace field'
[Windows.Automation.AutomationProperties]::SetAutomationId($replace, 'Replace')
$replace.Add_Click({
    $panel.Children.Remove($script:query)
    $script:query = New-Query
    $panel.Children.Insert(0, $script:query)
})
[void]$panel.Children.Add($replace)
$window.Add_ContentRendered({ $window.Activate(); $script:query.Focus() })
[void]$window.ShowDialog()
"#
            .replace("__TITLE__", &title);
            std::fs::write(&path, script).unwrap();
            let child = Command::new("powershell.exe")
                .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&path)
                .creation_flags(0x0800_0000)
                .spawn()
                .unwrap();
            let fixture = Fixture(child, path);
            let started = Instant::now();
            let window = loop {
                if let Some(window) = xcap::Window::all()
                    .unwrap()
                    .into_iter()
                    .find(|w| w.title().ok().as_deref() == Some(&title))
                {
                    break window;
                }
                assert!(started.elapsed() < Duration::from_secs(12), "Fixture did not open");
                std::thread::sleep(Duration::from_millis(100));
            };
            let hwnd = HWND(window.id().unwrap() as usize as *mut _);
            let (_apartment, automation) = automation().unwrap();
            let root = unsafe { automation.ElementFromHandle(hwnd) }.unwrap();
            let by_id = |id: &str| unsafe {
                let condition = automation
                    .CreatePropertyCondition(UIA_AutomationIdPropertyId, &VARIANT::from(id))
                    .unwrap();
                root.FindFirst(TreeScope_Subtree, &condition).unwrap()
            };
            let query = by_id("Query");
            unsafe { query.SetFocus() }.unwrap();
            let recording = Arc::new(Recording {
                id: "native-qa".into(),
                source: "desktop".into(),
                target: window.id().unwrap().to_string(),
                generation: 1,
                paused: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                steps: Mutex::new(vec![]),
                error: Mutex::new(String::new()),
                io: Mutex::new(()),
                desktop: Mutex::new(None),
            });
            start_worker(recording.clone(), |_| {}).unwrap();
            let set_value = |element: &IUIAutomationElement, value: &str| unsafe {
                element
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .unwrap()
                    .SetValue(&BSTR::from(value))
                    .unwrap();
            };
            let invoke = |element: &IUIAutomationElement| unsafe {
                element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .unwrap()
                    .Invoke()
                    .unwrap();
            };
            set_value(&query, "PRIVATE_CAPTURE_VALUE");
            invoke(&by_id("Apply"));
            let wait_for = |condition: &dyn Fn() -> bool| {
                let started = Instant::now();
                while !condition() {
                    assert!(
                        started.elapsed() < Duration::from_secs(5),
                        "Native recording event was not received: {:?}",
                        snapshot(&recording)
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            };
            wait_for(&|| {
                let steps = recording.steps.lock().unwrap();
                steps.iter().any(|s| s["recorded"]["operation"] == "fill")
                    && steps.iter().any(|s| s["recorded"]["operation"] == "invoke")
            });
            let first = recording.steps.lock().unwrap().clone();
            assert!(!serde_json::to_string(&first).unwrap().contains("PRIVATE_CAPTURE_VALUE"));
            let mut recorded = first.iter().find(|s| s["recorded"]["operation"] == "fill").unwrap()["recorded"].clone();
            assert_eq!(recorded["textValue"], "{{input}}");
            let controls = recording.desktop.lock().unwrap().as_ref().unwrap().clone();
            let (send, receive) = mpsc::channel();
            controls.send(DesktopControl::Pause(true, send)).unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            std::thread::sleep(Duration::from_millis(200));
            let count = recording.steps.lock().unwrap().len();
            set_value(&query, "PAUSED_VALUE");
            invoke(&by_id("Apply"));
            std::thread::sleep(Duration::from_millis(350));
            assert_eq!(recording.steps.lock().unwrap().len(), count);
            let (send, receive) = mpsc::channel();
            controls.send(DesktopControl::Pause(false, send)).unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            invoke(&by_id("Apply"));
            wait_for(&|| recording.steps.lock().unwrap().len() > count);
            let (send, receive) = mpsc::channel();
            controls.send(DesktopControl::Stop(send)).unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap();
            let count = recording.steps.lock().unwrap().len();
            invoke(&by_id("Replace"));
            std::thread::sleep(Duration::from_millis(200));
            recorded["textValue"] = json!("REPLAY_VERIFIED");
            replay(&recorded, &|| false, &mut |_| Ok(true)).unwrap();
            let fresh = by_id("Query");
            let actual = unsafe {
                fresh
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .unwrap()
                    .CurrentValue()
            }
            .unwrap();
            assert_eq!(actual.to_string(), "REPLAY_VERIFIED");
            assert_eq!(recording.steps.lock().unwrap().len(), count);
            assert!(recording.error.lock().unwrap().is_empty());
            drop(fixture);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recording() -> Recording {
        Recording {
            id: "test".into(),
            source: "browser".into(),
            target: "1".into(),
            generation: 1,
            paused: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            steps: Mutex::new(vec![]),
            error: Mutex::new(String::new()),
            io: Mutex::new(()),
            desktop: Mutex::new(None),
        }
    }
    #[test]
    fn recorded_inputs_are_placeholders_and_sensitive_targets_are_rejected() {
        assert!(protected("Password"));
        assert!(protected("cc-number"));
        assert!(!protected("Search"));
        let recording = recording();
        browser_event(
            &recording,
            json!({"operation":"fill","target":{"name":"Search"},"textValue":"PRIVATE_VALUE"}),
        )
        .unwrap();
        let steps = recording.steps.lock().unwrap();
        assert_eq!(steps[0]["recorded"]["textValue"], "{{input}}");
        assert_eq!(steps[0]["expected"], "");
        assert!(!steps[0].to_string().contains("PRIVATE_VALUE"));
    }
    #[test]
    fn capped_recording_marks_the_saved_draft_incomplete() {
        let recording = recording();
        for _ in 0..=LIMIT {
            append(&recording, json!({"kind":"browser","recorded":{"operation":"click"}}));
        }
        let steps = recording.steps.lock().unwrap();
        assert_eq!(steps.len(), LIMIT);
        assert!(steps.last().unwrap()["unresolved"]
            .as_str()
            .unwrap()
            .contains("incomplete"));
        assert!(recording.paused.load(Ordering::SeqCst));
    }
}
