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
}

/// Every field carries a `serde` default. Sub-projects B, C and D each add
/// sections to this file, so a settings.json written by today's build has to
/// keep loading after they land — and vice versa.
#[derive(Serialize, Deserialize, Clone)]
pub struct AiSettings {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_anthropic_model")]
    pub anthropic_model: String,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

fn default_anthropic_model() -> String {
    "claude-sonnet-5".to_string()
}

fn default_openai_model() -> String {
    "gpt-4o-mini".to_string()
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            anthropic_model: default_anthropic_model(),
            openai_model: default_openai_model(),
        }
    }
}

impl AiSettings {
    /// Models are stored per provider so switching Anthropic <-> OpenAI doesn't
    /// silently discard the other provider's choice.
    pub fn model_for(&self, provider: crate::ai::Provider) -> &str {
        match provider {
            crate::ai::Provider::Anthropic => &self.anthropic_model,
            crate::ai::Provider::Openai => &self.openai_model,
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
    if crate::ai::Provider::from_str(&settings.ai.provider).is_err() {
        settings.ai.provider = default_provider();
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
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
}
