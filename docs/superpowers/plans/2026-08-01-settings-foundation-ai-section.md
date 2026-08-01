# Settings Foundation + AI Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Synapse settings window, a Rust-owned `settings.json` store that broadcasts changes to all windows, and an AI settings section with provider selection, a model picker, and API key management.

**Architecture:** A new `settings.rs` mirrors the existing hand-rolled JSON store in `snippets.rs`, writing `settings.json` into `app_data_dir`. Tauri commands read and write it; on every write Rust emits a `settings-changed` event so the already-open (never closed, only hidden) AI panel updates live. `ai.rs` stops owning hardcoded model constants and instead receives a resolved model string, keeping it a pure HTTP/SSE module.

**Tech Stack:** Tauri v2, Rust (serde / serde_json / keyring / reqwest), React 18 + TypeScript + Vite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-settings-foundation-ai-section-design.md`. Read it before Task 1.
- **Window routing is by window label, not URL hash.** Tauri escapes `#` in `WebviewUrl::App`, so hash routing silently makes every window render the wheel.
- **Utility windows intercept `CloseRequested` and `hide()`** — closing a Tauri window destroys it and makes it unreusable. The settings window must follow this pattern.
- **API keys live only in the OS keychain** (`keyring`, per-target `windows-native` / `apple-native` features). They must never be written into `settings.json`.
- Every field on the settings structs carries `#[serde(default = "...")]` — sub-projects B, C, and D each add sections to this file.
- Only the AI section is rendered in the sidebar. No placeholder rows for unbuilt sections.
- No frontend test runner is added in this sub-project.
- Dev workflow, including the PATH refresh line, is in `PROGRESS.md` → "Dev workflow (copy-paste)".

---

### Task 1: Settings store (`settings.rs`)

**Files:**
- Create: `synapse/src-tauri/src/settings.rs`
- Modify: `synapse/src-tauri/src/lib.rs` (add `mod settings;` beside the existing `mod` declarations at the top)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub struct Settings { pub ai: AiSettings }`
  - `pub struct AiSettings { pub provider: String, pub anthropic_model: String, pub openai_model: String }` — both derive `Serialize, Deserialize, Clone`
  - `pub fn load(path: &std::path::Path) -> Settings` — never fails; returns defaults on missing or unparseable file
  - `pub fn save(path: &std::path::Path, settings: &Settings) -> Result<(), String>`
  - `impl AiSettings { pub fn model_for(&self, provider: crate::ai::Provider) -> &str }`

- [ ] **Step 1: Write the failing tests**

Create `synapse/src-tauri/src/settings.rs` with only the tests plus the minimum imports:

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

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
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
cargo test --lib settings
```

Expected: FAIL — `cannot find function 'load' in this scope` (and the same for `save`).

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)] mod tests` block in `settings.rs`:

```rust
/// Settings live in a plain JSON file beside snippets.json in the app data dir
/// (PRD §6.4 names tauri-plugin-store, but this project hand-rolls the same
/// pattern in snippets.rs / notes.rs — follow the code, not the PRD).
///
/// API keys are deliberately absent: they belong in the OS keychain (PRD §6.3).
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(default)]
    pub ai: AiSettings,
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
        Ok(settings) => settings,
        Err(e) => {
            eprintln!("[synapse] settings.json unparseable ({e}) — using defaults");
            Settings::default()
        }
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
```

Then add the module declaration in `lib.rs`, alongside the existing `mod` lines near the top:

```rust
mod settings;
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
cargo test --lib settings
```

Expected: PASS — `3 passed`. Then confirm nothing else broke:

```powershell
cargo test --lib
```

Expected: PASS — `4 passed` (the three above plus `ai::tests::api_key_survives_a_separate_entry`).

- [ ] **Step 5: Commit**

```bash
git add synapse/src-tauri/src/settings.rs synapse/src-tauri/src/lib.rs
git commit -m "feat(settings): add JSON settings store with forward-compat defaults"
```

---

### Task 2: Settings commands, window, and wheel wedge

**Files:**
- Modify: `synapse/src-tauri/src/lib.rs` (commands, `SETTINGS_LABEL`, window builder, `select_wedge` arm, `invoke_handler` list)
- Modify: `synapse/src/wedges.ts` (6th wedge)
- Modify: `synapse/src/App.tsx` (route the settings label)
- Create: `synapse/src/Settings.tsx` (minimal placeholder — Task 3 fills it in)

**Interfaces:**
- Consumes: `settings::{Settings, load, save}` from Task 1.
- Produces:
  - Tauri commands `get_settings() -> Settings`, `update_settings(app, settings: Settings) -> Result<(), String>`, `open_settings(app, section: Option<String>)`, `delete_api_key(provider: String) -> Result<(), String>`
  - Events `settings-changed` (payload: `Settings`) and `settings-navigate` (payload: `String` section id)
  - Window label `"settings"`
  - `WedgeId` gains `"settings"`

- [ ] **Step 1: Add the settings path helper and commands to `lib.rs`**

Add near the other window label constants at the top:

```rust
const SETTINGS_LABEL: &str = "settings";
```

Add these commands next to the existing `provider_status` / `set_api_key` commands:

```rust
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
fn delete_api_key(provider: String) -> Result<(), String> {
    ai::delete_api_key(ai::Provider::from_str(&provider)?)
}
```

Register all four in the `invoke_handler![...]` list, after `provider_status`:

```rust
            get_settings,
            update_settings,
            open_settings,
            delete_api_key,
```

- [ ] **Step 2: Add `delete_api_key` to `ai.rs`**

In `synapse/src-tauri/src/ai.rs`, next to `set_api_key` / `has_api_key`:

```rust
pub fn delete_api_key(provider: Provider) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        // Removing a key that isn't there is the state the caller wanted.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

- [ ] **Step 3: Add the settings window and wedge routing**

In the `.setup(|app| { ... })` block, after the `ai_panel` window builder, add:

```rust
            let settings_window =
                WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("index.html".into()))
                    .title("Synapse — Settings")
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
```

In `select_wedge`, add an arm beside the `"ai"` arm:

```rust
        "settings" => {
            hide_overlay(&app);
            show_utility_window(&app, SETTINGS_LABEL);
        }
```

- [ ] **Step 4: Add the wedge and the frontend route**

In `synapse/src/wedges.ts`, widen the union and append the wedge (the ring geometry is already count-driven, so nothing else changes):

```typescript
export type WedgeId = "stt" | "ai" | "screenshot" | "snippet" | "notepad" | "settings";
```

```typescript
  {
    id: "settings",
    label: "Settings",
    icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7.4 2a7.4 7.4 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.9-1.1L14.6 2H9.4L9 5.8a7.5 7.5 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.9 1.1l.4 3.8h5.2l.4-3.8a7.5 7.5 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.6c.07-.36.1-.73.1-1.1Z",
  },
```

Create `synapse/src/Settings.tsx` as a placeholder that Task 3 replaces:

```tsx
export default function Settings() {
  return <div>Settings</div>;
}
```

In `synapse/src/App.tsx`, import it and add the case:

```tsx
import Settings from "./Settings";
```

```tsx
    case "settings":
      return <Settings />;
```

- [ ] **Step 5: Build and verify the window opens**

```powershell
cd "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
cargo build
cd "C:\Users\sahil\Desktop\Synapse\synapse"
npx tsc --noEmit
```

Expected: both succeed with no errors. Then launch per `PROGRESS.md` → "Dev workflow", press **Ctrl+Alt+Enter**, and click the new Settings wedge. Expected: a 720×520 window titled "Synapse — Settings" showing the word "Settings". Close it with the X, re-open it from the wheel, and confirm it re-opens — that proves the `hide()`-on-close interception works.

- [ ] **Step 6: Commit**

```bash
git add synapse/src-tauri/src/lib.rs synapse/src-tauri/src/ai.rs synapse/src/wedges.ts synapse/src/App.tsx synapse/src/Settings.tsx
git commit -m "feat(settings): add settings window, wheel wedge, and store commands"
```

---

### Task 3: Model catalog, sidebar shell, and AI section

**Files:**
- Create: `synapse/src/models.ts`
- Create: `synapse/src/settings/AiSection.tsx`
- Create: `synapse/src/Settings.css`
- Modify: `synapse/src/Settings.tsx` (replace the Task 2 placeholder)

**Interfaces:**
- Consumes: `get_settings` / `update_settings` / `provider_status` / `set_api_key` / `delete_api_key` commands and the `settings-navigate` event from Task 2.
- Produces:
  - `synapse/src/models.ts`: `export type Provider = "anthropic" | "openai"`, `export interface Settings`, `export interface AiSettings`, `export const MODEL_CATALOG: Record<Provider, string[]>`, `export const PROVIDER_LABELS: Record<Provider, string>`
  - `AiSection` default export, props `{ settings: Settings; onChange: (next: Settings) => void }`

- [ ] **Step 1: Write the model catalog**

Create `synapse/src/models.ts`:

```typescript
export type Provider = "anthropic" | "openai";

export interface AiSettings {
  provider: Provider;
  anthropic_model: string;
  openai_model: string;
}

export interface Settings {
  ai: AiSettings;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

// Curated per provider, with a "Custom…" escape hatch in the picker — model
// lineups move faster than this app ships, and a dropdown alone would make a
// newly released model unreachable until the next release.
export const MODEL_CATALOG: Record<Provider, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-4o-mini", "gpt-4o"],
};

export function modelFor(settings: Settings, provider: Provider): string {
  return provider === "anthropic"
    ? settings.ai.anthropic_model
    : settings.ai.openai_model;
}
```

- [ ] **Step 2: Write the AI section**

Create `synapse/src/settings/AiSection.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MODEL_CATALOG,
  PROVIDER_LABELS,
  modelFor,
  type Provider,
  type Settings,
} from "../models";

const CUSTOM = "__custom__";

export default function AiSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const [status, setStatus] = useState<Record<Provider, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");

  const provider = settings.ai.provider;
  const model = modelFor(settings, provider);
  const catalog = MODEL_CATALOG[provider];
  // A model that isn't in the catalog is a custom one the user typed, so the
  // dropdown must land on "Custom…" and reveal the field pre-filled.
  const isCustom = !catalog.includes(model);

  function refreshStatus() {
    invoke<Record<Provider, boolean>>("provider_status").then(setStatus);
  }

  useEffect(refreshStatus, []);

  function setProvider(next: Provider) {
    onChange({ ...settings, ai: { ...settings.ai, provider: next } });
  }

  function setModel(next: string) {
    const key = provider === "anthropic" ? "anthropic_model" : "openai_model";
    onChange({ ...settings, ai: { ...settings.ai, [key]: next } });
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    try {
      setError("");
      await invoke("set_api_key", { provider, key: keyInput.trim() });
      setKeyInput("");
      refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeKey() {
    try {
      setError("");
      await invoke("delete_api_key", { provider });
      refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="set-section">
      <h2 className="set-title">AI</h2>

      <label className="set-row">
        <span className="set-label">Provider</span>
        <select
          className="set-input"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
        >
          {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>

      <label className="set-row">
        <span className="set-label">Model</span>
        <select
          className="set-input"
          value={isCustom ? CUSTOM : model}
          onChange={(e) =>
            setModel(e.target.value === CUSTOM ? "" : e.target.value)
          }
        >
          {catalog.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>

      {isCustom && (
        <label className="set-row">
          <span className="set-label" />
          <input
            className="set-input"
            placeholder="Model ID"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
      )}

      <div className="set-row">
        <span className="set-label">API key</span>
        <div className="set-key">
          <span
            className={`set-badge ${status[provider] ? "set-ok" : "set-missing"}`}
          >
            {status[provider] ? "Key set" : "No key"}
          </span>
          <input
            className="set-input"
            type="password"
            placeholder={`${PROVIDER_LABELS[provider]} API key`}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveKey()}
          />
          <button className="set-btn" onClick={saveKey}>
            Save
          </button>
          {status[provider] && (
            <button className="set-btn set-btn-quiet" onClick={removeKey}>
              Remove
            </button>
          )}
        </div>
      </div>

      {error && <div className="set-error">{error}</div>}
      <p className="set-hint">
        Keys are stored in the Windows Credential Manager, never in Synapse's
        settings file.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Write the sidebar shell**

Replace `synapse/src/Settings.tsx` entirely:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import AiSection from "./settings/AiSection";
import type { Settings as SettingsData } from "./models";
import "./Settings.css";

// Only sections that actually exist are listed. Sub-project B adds General,
// Microphone, Capture, Snippets, Voice, Permissions and About as they're built —
// a sidebar full of "coming soon" rows is dead UI.
const SECTIONS = [{ id: "ai", label: "AI" }] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [section, setSection] = useState<SectionId>("ai");
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<SettingsData>("get_settings").then(setSettings).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("settings-navigate", (e) => {
      if (SECTIONS.some((s) => s.id === e.payload)) {
        setSection(e.payload as SectionId);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Optimistic: render the change immediately, persist behind it. A failed
  // write surfaces as an error rather than a silently reverted control.
  function update(next: SettingsData) {
    setSettings(next);
    invoke("update_settings", { settings: next }).catch((e) => setError(String(e)));
  }

  if (!settings) {
    return <div className="set-root set-loading">Loading…</div>;
  }

  return (
    <div className="set-root">
      <nav className="set-sidebar">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`set-nav ${section === s.id ? "set-nav-active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="set-main">
        {error && <div className="set-error">{error}</div>}
        {section === "ai" && <AiSection settings={settings} onChange={update} />}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Write the stylesheet**

Create `synapse/src/Settings.css`, matching the dark palette already used in `AiPanel.css`:

```css
.set-root {
  display: flex;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: #1a1a1c;
  color: #eaeaea;
  font-family: -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
}

.set-loading {
  align-items: center;
  justify-content: center;
  opacity: 0.45;
}

.set-sidebar {
  width: 180px;
  flex-shrink: 0;
  padding: 12px 8px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.set-nav {
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #eaeaea;
  font: inherit;
  cursor: pointer;
}

.set-nav:hover {
  background: rgba(255, 255, 255, 0.06);
}

.set-nav-active {
  background: rgba(90, 170, 255, 0.16);
  color: #9fcaff;
}

.set-main {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.set-title {
  margin: 0 0 18px;
  font-size: 16px;
  font-weight: 600;
}

.set-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.set-label {
  width: 90px;
  flex-shrink: 0;
  opacity: 0.7;
  font-size: 12px;
}

.set-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 7px 9px;
  color: #eaeaea;
  font: inherit;
  outline: none;
}

.set-key {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.set-badge {
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.set-ok {
  background: rgba(90, 220, 130, 0.18);
  color: #7fe8a0;
}

.set-missing {
  background: rgba(255, 160, 80, 0.18);
  color: #ffb877;
}

.set-btn {
  padding: 7px 12px;
  border-radius: 6px;
  border: none;
  background: rgba(90, 170, 255, 0.85);
  color: #0a0a0c;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.set-btn-quiet {
  background: rgba(255, 255, 255, 0.08);
  color: #eaeaea;
}

.set-error {
  color: #ff8a8a;
  font-size: 12px;
  margin-bottom: 12px;
}

.set-hint {
  margin-top: 20px;
  font-size: 11px;
  opacity: 0.45;
  line-height: 1.5;
}
```

- [ ] **Step 5: Typecheck and verify**

```powershell
cd "C:\Users\sahil\Desktop\Synapse\synapse"
npx tsc --noEmit
```

Expected: no output (success). Then rebuild and relaunch per `PROGRESS.md`, open Settings from the wheel, and confirm: the sidebar shows a single "AI" row; switching Provider swaps the model list; selecting **Custom…** reveals a text field; and `%APPDATA%\com.synapse.app\settings.json` appears with the values you picked.

- [ ] **Step 6: Commit**

```bash
git add synapse/src/models.ts synapse/src/settings/AiSection.tsx synapse/src/Settings.tsx synapse/src/Settings.css
git commit -m "feat(settings): add sidebar shell, model catalog, and AI section"
```

---

### Task 4: Resolve the model in `ai.rs` from settings

**Files:**
- Modify: `synapse/src-tauri/src/ai.rs` (drop the model constants, take a model argument)
- Modify: `synapse/src-tauri/src/lib.rs` (`send_ai_message` resolves the model)

**Interfaces:**
- Consumes: `settings::load`, `AiSettings::model_for`, `settings_path` from Tasks 1–2.
- Produces: `pub fn stream_chat(app: &tauri::AppHandle, provider: Provider, model: &str, prompt: &str) -> Result<String, String>`

- [ ] **Step 1: Remove the constants and add the `model` parameter**

In `synapse/src-tauri/src/ai.rs`, delete these two lines and the three-line comment above them:

```rust
const ANTHROPIC_MODEL: &str = "claude-sonnet-5";
const OPENAI_MODEL: &str = "gpt-4o-mini";
```

Keep `ANTHROPIC_VERSION`. Change the `stream_chat` signature to:

```rust
/// `model` is resolved by the caller from settings — this module does no file
/// I/O, so it stays a pure HTTP/SSE client.
pub fn stream_chat(
    app: &tauri::AppHandle,
    provider: Provider,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
```

In the request bodies, replace `"model": ANTHROPIC_MODEL` with `"model": model` and `"model": OPENAI_MODEL` with `"model": model`.

Raise the Anthropic `max_tokens` from `4096` to `16000`:

```rust
                "max_tokens": 16000,
```

Add this comment directly above that line:

```rust
                // Headroom for thinking: on claude-opus-5 (offered in the model
                // picker) thinking is on by default and max_tokens caps thinking
                // *plus* response text, so a tight limit truncates mid-answer.
```

- [ ] **Step 2: Resolve the model in `send_ai_message`**

In `lib.rs`, replace the body of `send_ai_message` with:

```rust
#[tauri::command]
fn send_ai_message(app: tauri::AppHandle, provider: String, prompt: String) {
    std::thread::spawn(move || {
        let provider = match ai::Provider::from_str(&provider) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit("ai-error", e);
                return;
            }
        };
        let model = match settings_path(&app) {
            Ok(path) => settings::load(&path).ai.model_for(provider).to_string(),
            Err(e) => {
                let _ = app.emit("ai-error", e);
                return;
            }
        };
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
```

- [ ] **Step 3: Build and test**

```powershell
cd "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
cargo build
cargo test --lib
```

Expected: build succeeds with no warnings about unused constants; `4 passed`.

- [ ] **Step 4: Commit**

```bash
git add synapse/src-tauri/src/ai.rs synapse/src-tauri/src/lib.rs
git commit -m "refactor(ai): resolve model from settings instead of hardcoding"
```

---

### Task 5: Strip config out of the AI panel

**Files:**
- Modify: `synapse/src/AiPanel.tsx`
- Modify: `synapse/src/AiPanel.css`

**Interfaces:**
- Consumes: `get_settings` / `open_settings` commands, `settings-changed` event, `MODEL_CATALOG` / `PROVIDER_LABELS` / `modelFor` from `models.ts`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Rewrite the panel's config handling**

In `synapse/src/AiPanel.tsx`:

Replace the imports and the local `Provider` type with:

```tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PROVIDER_LABELS, modelFor, type Provider, type Settings } from "./models";
import "./AiPanel.css";
```

Replace the `provider`, `status` and `keyInput` state declarations with:

```tsx
  // Config is owned by the Settings window now; this panel just reads it.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(false);
```

Delete the `saveKey` function entirely.

Replace the `refreshStatus` function and its `useEffect` with:

```tsx
  function refresh() {
    invoke<Settings>("get_settings").then((s) => {
      setSettings(s);
      invoke<Record<Provider, boolean>>("provider_status").then((status) =>
        setHasKey(status[s.ai.provider]),
      );
    });
  }

  useEffect(refresh, []);

  // The panel is hidden rather than closed, so an open window would otherwise
  // keep showing stale config after Settings changed it.
  useEffect(() => {
    const unlisten = listen<Settings>("settings-changed", () => refresh());
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
```

In `send` and `recordAndSend`, replace `invoke("send_ai_message", { provider, prompt: text })` with:

```tsx
    invoke("send_ai_message", { provider: settings?.ai.provider, prompt: text });
```

Replace the entire `ai-provider-row` block and the `{!hasKey && (...)}` key form with:

```tsx
      <div className="ai-provider-row">
        <span className="ai-config">
          {settings
            ? `${PROVIDER_LABELS[settings.ai.provider]} · ${modelFor(settings, settings.ai.provider)}`
            : "…"}
        </span>
        <label className="ai-speak-toggle">
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={(e) => setSpeakReplies(e.target.checked)}
          />
          Speak replies
        </label>
      </div>
```

In the response area, replace the empty-state line so a missing key gets an actionable prompt instead of a dead "Ask something below":

```tsx
        {!error && !response && !streaming && !recording && (
          hasKey ? (
            <div className="ai-empty">Ask something below, or use the mic…</div>
          ) : (
            <div className="ai-empty">
              No API key set.
              <button
                className="ai-settings-link"
                onClick={() => invoke("open_settings", { section: "ai" })}
              >
                Open Settings…
              </button>
            </div>
          )
        )}
```

- [ ] **Step 2: Update the stylesheet**

In `synapse/src/AiPanel.css`, delete the now-unused `.ai-provider-select`, `.ai-key-badge`, `.ai-key-ok`, `.ai-key-missing`, `.ai-key-form`, `.ai-key-input` and `.ai-key-save` rules, and add:

```css
.ai-config {
  flex: 1;
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-settings-link {
  display: block;
  margin-top: 8px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 170, 255, 0.4);
  background: rgba(90, 170, 255, 0.14);
  color: #eaeaea;
  font-size: 12px;
  cursor: pointer;
}
```

- [ ] **Step 3: Typecheck**

```powershell
cd "C:\Users\sahil\Desktop\Synapse\synapse"
npx tsc --noEmit
```

Expected: no output. A `Provider is declared but never read` error means a leftover import — remove it.

- [ ] **Step 4: Commit**

```bash
git add synapse/src/AiPanel.tsx synapse/src/AiPanel.css
git commit -m "refactor(ai-panel): move config to Settings, add deep-link"
```

---

### Task 6: End-to-end verification

**Files:** none modified.

**Interfaces:** consumes everything from Tasks 1–5.

- [ ] **Step 1: Full build and test**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
cargo test --lib
cargo build
cd "C:\Users\sahil\Desktop\Synapse\synapse"
npx tsc --noEmit
```

Expected: `4 passed`, a clean build, and a clean typecheck.

- [ ] **Step 2: Manual click-through**

Launch per `PROGRESS.md` → "Dev workflow", then walk this list, confirming each:

1. **Ctrl+Alt+Enter** → the wheel shows six wedges, evenly spaced and antialiased.
2. Settings wedge → the Settings window opens with an "AI" sidebar row.
3. Set provider to OpenAI, paste a real key, click **Save** → the badge flips to "Key set".
4. Pick `gpt-4o-mini` from the Model dropdown.
5. Open the AI panel (**Ctrl+Alt+Enter** → AI). The header reads `OpenAI · gpt-4o-mini`.
6. **Leave the AI panel open.** In Settings, switch the model to `gpt-4o`. The AI panel header updates live — this is the `settings-changed` broadcast doing its job, and is the whole reason the event exists.
7. Switch back to `gpt-4o-mini`, type a prompt in the panel, press Enter → the response streams in.
8. Click **Insert into focused field** → the text pastes into whatever app had focus.
9. In Settings, click **Remove** on the key → the badge flips to "No key"; the AI panel's empty state becomes "No API key set" with an **Open Settings…** button.
10. Click that button → the Settings window comes to the front on the AI section.
11. Re-save the key. In Settings pick **Custom…**, type `not-a-real-model`, send a prompt → the panel shows the provider's verbatim error rather than hanging.
12. Quit and relaunch → provider, model, and key all persist.

- [ ] **Step 3: Update PROGRESS.md**

Move M5's settings-window and model-picker items out of "Known gaps" and record what shipped: the settings window, `settings.json` store with `settings-changed` broadcast, the AI section, and the 6th wedge. Note the carry-forward for sub-project B: **choosing the wheel wedge over a system tray leaves the app with no quit path**, so General or About must add an explicit "Quit Synapse" button.

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md
git commit -m "docs: record settings foundation completion in PROGRESS.md"
```
