use serde::{Deserialize, Serialize};
use std::path::Path;

/// Settings live in a plain JSON file beside snippets.json in the app data dir
/// (PRD §6.4 names tauri-plugin-store, but this project hand-rolls the same
/// pattern in snippets.rs / notes.rs — follow the code, not the PRD).
///
/// API keys are deliberately absent: they belong in the OS keychain (PRD §6.3).
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub tts: TtsSettings,
    #[serde(default)]
    pub voice: VoiceSettings,
    #[serde(default)]
    pub clipboard: ClipboardSettings,
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
    #[serde(default)]
    pub appearance: AppearanceSettings,
}

/// Every field carries a `serde` default. Sub-projects B, C and D each add
/// sections to this file, so a settings.json written by today's build has to
/// keep loading after they land — and vice versa.
#[derive(Serialize, Deserialize, Clone)]
pub struct AiSettings {
    #[serde(default = "default_true")]
    pub hybrid: bool,
    #[serde(default = "default_daily_budget")]
    pub daily_budget: f64,
    #[serde(default)]
    pub custom_greetings: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_anthropic_model")]
    pub anthropic_model: String,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    #[serde(default = "default_openrouter_model")]
    pub openrouter_model: String,
    #[serde(default = "default_true")]
    pub speak_replies: bool,
    #[serde(default)]
    pub typing_mode: bool,
    #[serde(default = "default_true")]
    pub enter_to_send: bool,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

fn default_daily_budget() -> f64 {
    1.0
}

fn default_anthropic_model() -> String {
    "claude-sonnet-5".to_string()
}

fn default_openai_model() -> String {
    "gpt-4o-mini".to_string()
}

fn default_openrouter_model() -> String {
    "openrouter/auto".to_string()
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            custom_greetings: String::new(),
            hybrid: true,
            daily_budget: default_daily_budget(),
            provider: default_provider(),
            anthropic_model: default_anthropic_model(),
            openai_model: default_openai_model(),
            openrouter_model: default_openrouter_model(),
            speak_replies: true,
            typing_mode: false,
            enter_to_send: true,
        }
    }
}

impl AiSettings {
    /// Models are stored per provider so switching providers doesn't
    /// silently discard the other provider's choice.
    pub fn model_for(&self, provider: crate::ai::Provider) -> &str {
        match provider {
            crate::ai::Provider::Anthropic => &self.anthropic_model,
            crate::ai::Provider::Openai => &self.openai_model,
            crate::ai::Provider::Openrouter => &self.openrouter_model,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TtsSettings {
    #[serde(default = "default_voice")]
    pub voice: String,
}

fn default_voice() -> String {
    "alba".to_string()
}

pub const TTS_VOICES: &[&str] = &["alba", "giovanni", "lola", "juergen", "rafael", "estelle"];

pub fn is_tts_voice(voice: &str) -> bool {
    TTS_VOICES.contains(&voice)
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self { voice: default_voice() }
    }
}

/// Dictation (speech-to-text) behaviour, as distinct from `TtsSettings`, which
/// is the speaking side.
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct VoiceSettings {
    /// Off by default: dictation ends when the user says it ends, not when the
    /// microphone happens to go quiet mid-thought. Turning this on restores the
    /// hands-free behaviour for people who want it.
    #[serde(default)]
    pub auto_stop_on_silence: bool,
    #[serde(default = "default_silence_ms")]
    pub silence_ms: u64,
    #[serde(default = "default_speech_threshold")]
    pub speech_threshold: f32,
}

fn default_silence_ms() -> u64 {
    900
}
fn default_speech_threshold() -> f32 {
    0.015
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            auto_stop_on_silence: false,
            silence_ms: default_silence_ms(),
            speech_threshold: default_speech_threshold(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct ShortcutSettings {
    #[serde(default = "default_wheel_shortcut")]
    pub wheel: String,
    #[serde(default = "default_dictation_shortcut")]
    pub dictation: String,
    #[serde(default)]
    pub tools: std::collections::BTreeMap<String, String>,
}

fn default_wheel_shortcut() -> String {
    "Control+Alt+Enter".into()
}
fn default_dictation_shortcut() -> String {
    "Control+Alt+D".into()
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            wheel: default_wheel_shortcut(),
            dictation: default_dictation_shortcut(),
            tools: Default::default(),
        }
    }
}

pub const TOOL_IDS: &[&str] = &[
    "stt",
    "ai",
    "screenshot",
    "clipboard",
    "notepad",
    "speak-selected",
    "settings",
    "quit",
];

#[derive(Serialize, Deserialize, Clone)]
pub struct AppearanceSettings {
    #[serde(default = "default_wheel_size")]
    pub wheel_size: u16,
    #[serde(default = "default_accent")]
    pub accent: String,
    #[serde(default = "default_wheel_tools")]
    pub wheel_tools: Vec<String>,
}
fn default_wheel_size() -> u16 {
    100
}
fn default_accent() -> String {
    "neutral".into()
}
fn default_wheel_tools() -> Vec<String> {
    TOOL_IDS.iter().map(|id| (*id).into()).collect()
}
impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            wheel_size: default_wheel_size(),
            accent: default_accent(),
            wheel_tools: default_wheel_tools(),
        }
    }
}
impl AppearanceSettings {
    fn valid(&self) -> bool {
        ["neutral", "blue", "violet", "amber"].contains(&self.accent.as_str())
            && (75..=150).contains(&self.wheel_size)
            && self.wheel_tools.len() >= 2
            && self.wheel_tools.iter().any(|id| id == "settings")
            && self.wheel_tools.iter().all(|id| TOOL_IDS.contains(&id.as_str()))
            && self.wheel_tools.iter().collect::<std::collections::HashSet<_>>().len() == self.wheel_tools.len()
    }
}

impl ShortcutSettings {
    pub fn parsed(&self) -> Result<Vec<(tauri_plugin_global_shortcut::Shortcut, String)>, String> {
        use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
        let mut parsed = Vec::new();
        for (action, value) in [("wheel", &self.wheel), ("stt", &self.dictation)]
            .into_iter()
            .chain(self.tools.iter().map(|(key, value)| (key.as_str(), value)))
        {
            if action != "wheel" && !TOOL_IDS.contains(&action) {
                return Err(format!("Unknown tool: {action}"));
            }
            if action != "wheel" && action != "stt" && value.is_empty() {
                continue;
            }
            if self.tools.contains_key("stt") {
                return Err("Use the dictation shortcut for speech-to-text.".into());
            }
            let shortcut: Shortcut = value.parse().map_err(|e| format!("Invalid shortcut: {e}"))?;
            if !shortcut
                .mods
                .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
            {
                return Err("Use Control, Alt or Super with a key.".into());
            }
            if parsed.iter().any(|(existing, _)| *existing == shortcut) {
                return Err("Each tool needs a different shortcut.".into());
            }
            parsed.push((shortcut, action.to_string()));
        }
        Ok(parsed)
    }
    pub fn keys(&self) -> Result<Vec<tauri_plugin_global_shortcut::Shortcut>, String> {
        Ok(self.parsed()?.into_iter().map(|(key, _)| key).collect())
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ClipboardSettings {
    /// Clipboard history is a persistent log of everything copied, which will
    /// include passwords and one-time codes. It ships on because that is what
    /// makes the feature useful, but it must always be switchable off without
    /// a restart — the watcher re-reads this every poll.
    #[serde(default = "default_true")]
    pub history_enabled: bool,
    #[serde(default = "default_true")]
    pub capture_text: bool,
    #[serde(default = "default_true")]
    pub capture_images: bool,
    #[serde(default = "default_true")]
    pub capture_links: bool,
    #[serde(default = "default_true")]
    pub capture_files: bool,
    #[serde(default = "default_retention_days")]
    pub retention_days: u32,
    #[serde(default = "default_max_unpinned_items")]
    pub max_unpinned_items: usize,
    #[serde(default = "default_max_storage_mb")]
    pub max_storage_mb: u64,
}

fn default_true() -> bool {
    true
}

fn default_retention_days() -> u32 {
    30
}

fn default_max_unpinned_items() -> usize {
    500
}

fn default_max_storage_mb() -> u64 {
    250
}

impl Default for ClipboardSettings {
    fn default() -> Self {
        Self {
            history_enabled: default_true(),
            capture_text: default_true(),
            capture_images: default_true(),
            capture_links: default_true(),
            capture_files: default_true(),
            retention_days: default_retention_days(),
            max_unpinned_items: default_max_unpinned_items(),
            max_storage_mb: default_max_storage_mb(),
        }
    }
}

/// Takes a `&Path` rather than an `AppHandle` so it's testable without a Tauri
/// runtime. Never fails: a missing or unreadable file is a fresh install, and a
/// corrupt one shouldn't stop the app from starting.
pub fn load(path: &Path) -> Settings {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str(&content) {
        Ok(mut settings) => {
            normalize(&mut settings);
            settings
        }
        Err(e) => {
            eprintln!("[synapse] settings.json unparseable ({e}) — using defaults");
            Settings::default()
        }
    }
}

/// `#[serde(default = ...)]` only fires for a *missing* field, not an
/// unrecognised one — a hand-edited or future settings.json with
/// `"provider": "gemini"` parses fine as a plain `String` and would otherwise
/// reach the frontend, where `MODEL_CATALOG[provider]` is `undefined` and
/// crashes the Settings window. Fold any value `Provider::from_str` doesn't
/// recognise back to the default here so the guarantee is enforced once, in
/// the one place that owns settings loading, rather than relying on every
/// consumer to defend against it.
fn normalize(settings: &mut Settings) {
    if !settings.appearance.valid() {
        settings.appearance = AppearanceSettings::default();
    }
    if crate::ai::Provider::from_str(&settings.ai.provider).is_err() {
        settings.ai.provider = default_provider();
    }
    settings.voice.silence_ms = settings.voice.silence_ms.clamp(300, 3000);
    settings.voice.speech_threshold = settings.voice.speech_threshold.clamp(0.005, 0.05);
    if settings.shortcuts.parsed().is_err() {
        settings.shortcuts = ShortcutSettings::default();
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if !settings.ai.daily_budget.is_finite() || !(0.01..=100.0).contains(&settings.ai.daily_budget) {
        return Err("Daily AI budget must be between $0.01 and $100.".into());
    }
    if settings.ai.custom_greetings.chars().count() > 4000 {
        return Err("Keep custom greetings within 4,000 characters.".into());
    }
    if !settings.appearance.valid() {
        return Err("Choose a supported accent and at least one tool alongside Settings.".into());
    }
    settings.shortcuts.parsed()?;
    if !(300..=3000).contains(&settings.voice.silence_ms) || !(0.005..=0.05).contains(&settings.voice.speech_threshold)
    {
        return Err("Dictation timing or microphone sensitivity is out of range.".into());
    }
    // Back up anything we couldn't parse before clobbering it. Silently
    // destroying a file the user may have hand-edited is worse than a stale .bak.
    if let Ok(existing) = std::fs::read_to_string(path) {
        if serde_json::from_str::<Settings>(&existing).is_err() {
            let backup = path.with_extension("json.bak");
            if let Err(e) = std::fs::write(&backup, &existing) {
                eprintln!("[synapse] failed to back up unparseable settings: {e}");
            }
        }
    }

    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_defaults_and_preserves_each_providers_model() {
        let path = temp_dir("openrouter").join("settings.json");
        std::fs::write(&path, r#"{"ai":{"provider":"openai","openai_model":"gpt-4o"}}"#).unwrap();
        let mut settings = load(&path);
        assert_eq!(settings.ai.openrouter_model, "openrouter/auto");
        settings.ai.provider = "openrouter".into();
        settings.ai.openrouter_model = "provider/custom-model".into();
        save(&path, &settings).unwrap();
        let restored = load(&path);
        assert_eq!(restored.ai.provider, "openrouter");
        assert_eq!(
            restored.ai.model_for(crate::ai::Provider::Openrouter),
            "provider/custom-model"
        );
        assert_eq!(restored.ai.model_for(crate::ai::Provider::Openai), "gpt-4o");
        assert_eq!(
            restored.ai.model_for(crate::ai::Provider::Anthropic),
            default_anthropic_model()
        );
    }

    #[test]
    fn custom_greetings_default_and_persist() {
        let path = temp_dir("greetings").join("settings.json");
        std::fs::write(&path, r#"{"ai":{"provider":"openai"}}"#).unwrap();
        let mut settings = load(&path);
        assert!(settings.ai.custom_greetings.is_empty());
        settings.ai.custom_greetings = "Hello, Sahil!\nWelcome back.".into();
        save(&path, &settings).unwrap();
        assert_eq!(load(&path).ai.custom_greetings, settings.ai.custom_greetings);
        settings.ai.custom_greetings = "x".repeat(4001);
        assert!(save(&path, &settings).is_err());
        assert_eq!(load(&path).ai.custom_greetings, "Hello, Sahil!\nWelcome back.");
    }

    #[test]
    fn appearance_and_tool_shortcuts_are_validated_and_persisted() {
        let path = temp_dir("appearance-tools").join("settings.json");
        let mut settings = Settings::default();
        settings.appearance.accent = "violet".into();
        settings.appearance.wheel_size = 125;
        settings.appearance.wheel_tools = vec!["clipboard".into(), "settings".into()];
        settings
            .shortcuts
            .tools
            .insert("clipboard".into(), "Control+Shift+V".into());
        save(&path, &settings).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.appearance.accent, "violet");
        assert_eq!(loaded.appearance.wheel_size, 125);
        settings.appearance.wheel_size = 151;
        assert!(save(&path, &settings).is_err());
        settings.appearance.wheel_size = 125;
        assert_eq!(loaded.appearance.wheel_tools, vec!["clipboard", "settings"]);
        assert_eq!(loaded.shortcuts.parsed().unwrap().len(), 3);
        settings.shortcuts.tools.insert("notepad".into(), "Ctrl+Shift+V".into());
        assert!(
            save(&path, &settings).is_err(),
            "aliases must not bypass duplicate detection"
        );
        settings.shortcuts.tools.remove("notepad");
        settings.appearance.wheel_tools = vec!["clipboard".into()];
        assert!(save(&path, &settings).is_err(), "settings must stay reachable");
        settings.appearance.wheel_tools = vec!["settings".into()];
        assert!(save(&path, &settings).is_err(), "a wheel requires two segments");
        settings.appearance = AppearanceSettings::default();
        settings.shortcuts.tools.insert("unknown".into(), "Control+U".into());
        assert!(save(&path, &settings).is_err());
    }

    #[test]
    fn control_preferences_default_validate_and_persist() {
        let path = temp_dir("controls").join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        let mut settings = load(&path);
        assert!(settings.ai.speak_replies);
        assert!(settings.ai.enter_to_send);
        assert!(!settings.ai.typing_mode);
        assert_eq!(settings.voice.silence_ms, 900);
        assert_eq!(settings.voice.speech_threshold, 0.015);
        assert!(settings.shortcuts.parsed().is_ok());
        settings.shortcuts.wheel = "Control+Shift+Space".into();
        settings.voice.silence_ms = 2000;
        settings.voice.speech_threshold = 0.03;
        settings.ai.speak_replies = false;
        settings.ai.typing_mode = true;
        settings.ai.enter_to_send = false;
        save(&path, &settings).unwrap();
        let restored = load(&path);
        assert_eq!(restored.shortcuts.wheel, "Control+Shift+Space");
        assert_eq!(restored.voice.silence_ms, 2000);
        assert_eq!(restored.voice.speech_threshold, 0.03);
        assert!(!restored.ai.speak_replies);
        assert!(restored.ai.typing_mode);
        assert!(!restored.ai.enter_to_send);
        settings.shortcuts.dictation = "Ctrl+Shift+Space".into();
        assert!(
            save(&path, &settings).is_err(),
            "aliases must not allow duplicate shortcuts"
        );
        settings.shortcuts.dictation = "D".into();
        assert!(
            save(&path, &settings).is_err(),
            "plain typing must not activate Synapse"
        );
        settings.shortcuts = ShortcutSettings::default();
        settings.voice.silence_ms = 0;
        assert!(save(&path, &settings).is_err());
        settings.voice.silence_ms = 900;
        settings.voice.speech_threshold = f32::NAN;
        assert!(save(&path, &settings).is_err());
        assert_eq!(load(&path).voice.silence_ms, 2000, "invalid saves preserve the file");
    }

    /// Each test gets its own directory so they can run in parallel.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-settings-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn defaults_when_file_missing() {
        let path = temp_dir("missing").join("settings.json");
        let settings = load(&path);
        assert_eq!(settings.ai.provider, "anthropic");
        assert_eq!(settings.ai.anthropic_model, "claude-sonnet-5");
        assert_eq!(settings.ai.openai_model, "gpt-4o-mini");
    }

    /// Forward/backward-compat guard for sub-projects B, C and D: a file written
    /// by an older build (missing fields) or a newer one (unknown fields) must
    /// still load, filling the gaps from defaults rather than failing the parse.
    #[test]
    fn round_trips_with_missing_and_unknown_fields() {
        let path = temp_dir("partial").join("settings.json");
        std::fs::write(
            &path,
            r#"{"ai":{"openai_model":"gpt-4o"},"hotkeys":{"wheel":"Ctrl+Alt+Enter"}}"#,
        )
        .expect("write partial settings");

        let settings = load(&path);
        assert_eq!(settings.ai.openai_model, "gpt-4o", "present field is read");
        assert_eq!(settings.ai.provider, "anthropic", "missing field defaults");
        assert_eq!(settings.ai.anthropic_model, "claude-sonnet-5");
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults_and_backs_up() {
        let dir = temp_dir("corrupt");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ this is not json").expect("write corrupt settings");

        let settings = load(&path);
        assert_eq!(settings.ai.provider, "anthropic", "defaults on corrupt file");

        save(&path, &settings).expect("save over corrupt file");

        let backup = dir.join("settings.json.bak");
        assert_eq!(
            std::fs::read_to_string(&backup).expect("backup exists"),
            "{ this is not json",
            "unparseable file is preserved before being overwritten"
        );
        assert!(load(&path).ai.provider == "anthropic", "new file is readable");
    }

    #[test]
    fn unknown_provider_falls_back_to_default() {
        let path = temp_dir("unknown-provider").join("settings.json");
        std::fs::write(&path, r#"{"ai":{"provider":"gemini"}}"#).expect("write settings");

        let settings = load(&path);
        assert_eq!(settings.ai.provider, "anthropic");
    }

    #[test]
    fn onboarding_complete_defaults_false_and_persists_true() {
        let path = temp_dir("onboarding").join("settings.json");

        let mut settings = load(&path);
        assert!(!settings.onboarding_complete, "defaults false for a fresh install");

        settings.onboarding_complete = true;
        save(&path, &settings).expect("save settings");

        let reloaded = load(&path);
        assert!(reloaded.onboarding_complete, "persists across a reload");
    }

    #[test]
    fn tts_voice_defaults_and_persists() {
        let path = temp_dir("tts-voice").join("settings.json");

        let mut settings = load(&path);
        assert_eq!(settings.tts.voice, "alba", "defaults to alba for a fresh install");

        settings.tts.voice = "giovanni".to_string();
        save(&path, &settings).expect("save settings");

        let reloaded = load(&path);
        assert_eq!(reloaded.tts.voice, "giovanni", "persists across a reload");
    }

    #[test]
    fn auto_stop_on_silence_defaults_off_and_persists() {
        let path = temp_dir("auto-stop").join("settings.json");

        let mut settings = load(&path);
        assert!(
            !settings.voice.auto_stop_on_silence,
            "dictation is manual-stop by default"
        );

        settings.voice.auto_stop_on_silence = true;
        save(&path, &settings).expect("save settings");
        assert!(load(&path).voice.auto_stop_on_silence, "persists across a reload");
    }

    /// A settings.json written before the clipboard feature existed has no
    /// `clipboard` key at all, and must come back with history enabled rather
    /// than silently off (which would look like a broken feature).
    #[test]
    fn clipboard_history_defaults_on_for_files_predating_the_feature() {
        let path = temp_dir("clip-default").join("settings.json");
        std::fs::write(&path, r#"{"ai":{"provider":"openai"}}"#).expect("write settings");

        let settings = load(&path);
        assert!(settings.clipboard.history_enabled);
    }

    #[test]
    fn clipboard_history_can_be_turned_off_and_stays_off() {
        let path = temp_dir("clip-off").join("settings.json");

        let mut settings = load(&path);
        settings.clipboard.history_enabled = false;
        save(&path, &settings).expect("save settings");

        assert!(
            !load(&path).clipboard.history_enabled,
            "an explicit false must not be re-defaulted back to true"
        );
    }

    #[test]
    fn clipboard_retention_defaults_match_the_product_limits() {
        let path = temp_dir("clip-retention-defaults").join("settings.json");
        let settings = load(&path);

        assert_eq!(settings.clipboard.retention_days, 30);
        assert_eq!(settings.clipboard.max_unpinned_items, 500);
        assert_eq!(settings.clipboard.max_storage_mb, 250);
        assert!(settings.clipboard.capture_text);
        assert!(settings.clipboard.capture_images);
        assert!(settings.clipboard.capture_links);
        assert!(settings.clipboard.capture_files);
    }

    #[test]
    fn clipboard_retention_and_capture_choices_persist() {
        let path = temp_dir("clip-retention-custom").join("settings.json");
        let mut settings = load(&path);
        settings.clipboard.retention_days = 7;
        settings.clipboard.max_unpinned_items = 120;
        settings.clipboard.max_storage_mb = 64;
        settings.clipboard.capture_images = false;
        settings.clipboard.capture_files = false;
        save(&path, &settings).expect("save settings");

        let reloaded = load(&path);
        assert_eq!(reloaded.clipboard.retention_days, 7);
        assert_eq!(reloaded.clipboard.max_unpinned_items, 120);
        assert_eq!(reloaded.clipboard.max_storage_mb, 64);
        assert!(!reloaded.clipboard.capture_images);
        assert!(!reloaded.clipboard.capture_files);
        assert!(reloaded.clipboard.capture_text);
    }

    #[test]
    fn tts_settings_missing_from_file_defaults_gracefully() {
        let path = temp_dir("tts-missing").join("settings.json");
        std::fs::write(&path, r#"{"ai":{"provider":"anthropic"}}"#).expect("write settings");

        let settings = load(&path);
        assert_eq!(
            settings.tts.voice, "alba",
            "missing tts section defaults, does not fail parse"
        );
    }

    #[test]
    fn only_bundled_tts_voices_are_accepted() {
        assert!(is_tts_voice("alba"));
        assert!(is_tts_voice("estelle"));
        assert!(!is_tts_voice("../../custom"));
        assert!(!is_tts_voice(""));
    }
}
