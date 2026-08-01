# Settings Foundation + AI Section — Design

**Date:** 2026-08-01
**Status:** Approved, ready for implementation planning
**Scope:** Sub-project A of the M5+M6 decomposition

---

## Context

M5 (Settings/onboarding) and M6 (Packaging) were originally one roadmap line each. Exploring
the codebase showed they span four largely independent subsystems, so they were decomposed:

| | Sub-project | Contains |
|---|---|---|
| **A** | Settings foundation + AI section | Settings window, sidebar shell, `settings.json` store, AI section (provider, model picker, key management) |
| **B** | Remaining settings sections | General (dynamic hotkeys, launch at login, Quit), Microphone, Capture, Snippets CRUD, Voice/ASR, Permissions, About |
| **C** | Onboarding + model download | First-run wizard, 640 MB resumable download with progress, move ASR off its hardcoded relative path |
| **D** | Packaging | `.msi` bundle, notify-only GitHub-releases update check, install docs |

Agreed build order: **A → C → B → D**. A must go first — it builds the settings store and window
shell that B, C, and D all hang off. C precedes B because it is the ship-blocker (the app cannot
currently be installed by anyone else) while B is mostly breadth with few unknowns.

**This document specs A only.**

### Findings that shaped this design

- The project has **no `tauri-plugin-store`**, despite PRD §6.4 implying one. `snippets.rs` and
  `notes.rs` hand-roll JSON into `app_data_dir`. Settings follows that existing pattern.
- Utility windows are **reused via `hide()`, never closed** (closing a Tauri window destroys it).
  An already-open AI panel therefore cannot be relied on to re-read config on next display —
  cross-window change propagation is a real requirement, not speculation.
- `keyring` required a per-target platform-store feature; without it the crate silently compiled
  in its in-memory `mock` store. Fixed separately (see PROGRESS.md). Relevant here because A moves
  key management into Settings and adds key deletion.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Settings entry point | **6th wedge in the radial wheel** | `wedgePath`/`iconPosition` are already count-driven, so the ring absorbs a 6th item with no geometry work. Rejected: system tray (more surface), centre-hub gear. |
| State ownership | **Rust-owned store + change broadcast** | Matches `snippets.rs`. Lets `ai.rs` resolve its own model rather than trusting a frontend-supplied one. Rejected: `tauri-plugin-store` (new dependency, pushes config knowledge into the caller); re-read-on-show (stale config in reused windows). |
| Model selection | **Curated dropdown + `Custom…` free text** | Friendly default, never blocks a model newer than the app. |
| AI panel after Settings exists | **Deep-link, no inline config** | Single source of truth. The panel returns to being purely a chat surface. |
| Sections rendered in A | **AI only** | A sidebar of "coming soon" rows is dead UI. B adds rows as they become real. |
| Frontend tests | **None in A** | The repo has no frontend test runner. Adding Vitest is a separate decision with its own scope, not something to smuggle into this work. |

**Consequence to carry into B:** choosing the wheel wedge over a tray icon leaves the app with no
quit path. B's General or About section must add an explicit "Quit Synapse" button.

---

## Components

| File | Change |
|---|---|
| `src-tauri/src/settings.rs` | **new** — `Settings`/`AiSettings` structs, `load`/`save`, defaults |
| `src-tauri/src/lib.rs` | `get_settings`, `update_settings`, `open_settings`, `delete_api_key` commands; `SETTINGS_LABEL` window; wedge routing |
| `src-tauri/src/ai.rs` | remove `ANTHROPIC_MODEL`/`OPENAI_MODEL` consts; `stream_chat` takes a resolved model argument |
| `src/Settings.tsx` | **new** — sidebar shell + section router |
| `src/settings/AiSection.tsx` | **new** — provider select, model picker, key management |
| `src/models.ts` | **new** — per-provider model catalog |
| `src/AiPanel.tsx` | strip inline provider/key UI; read-only header + "Open Settings…" |
| `src/wedges.ts` | add the `settings` wedge |
| `src/App.tsx` | route the settings window label |

Routing is **by window label, not URL hash** — Tauri escapes `#` in `WebviewUrl::App`, which
silently makes every window render the wheel.

---

## Data model

```rust
pub struct Settings {
    pub ai: AiSettings,
}

pub struct AiSettings {
    pub provider: String,        // "anthropic" | "openai"
    pub anthropic_model: String, // default "claude-sonnet-5"
    pub openai_model: String,    // default "gpt-4o-mini"
}
```

Stored at `app_data_dir/settings.json`, alongside `snippets.json`.

Two constraints on this struct:

- **Models are stored per provider**, not as a single `model` field, so switching provider does not
  silently discard the other provider's model choice.
- **Every field carries `#[serde(default = ...)]`.** B, C, and D each add sections to this file; a
  `settings.json` written by today's build must still load after they land.

API keys stay in the OS keychain and never enter this file (PRD §6.3).

`provider` is persisted as a `String` rather than the existing `ai::Provider` enum, so an
unrecognised value in a hand-edited or future-written file degrades to the default instead of
failing the whole parse. It is converted through the existing `Provider::from_str` at use.

The exact Anthropic model IDs for `models.ts` must be confirmed against the `claude-api` skill at
implementation time rather than written from memory.

---

## Data flow

1. Settings window mounts → `invoke("get_settings")`.
2. User changes provider or model → `invoke("update_settings", { settings })`.
3. Rust writes `settings.json`, then emits **`settings-changed`** carrying the new `Settings`.
4. The AI panel listens for `settings-changed` and updates its read-only header — correct even
   though the panel was only hidden, never closed.
5. On send, `send_ai_message` loads settings, resolves the model for the active provider, and
   passes it into `stream_chat`. `ai.rs` performs no file I/O and stays a pure HTTP/SSE module.

Deep-link: the AI panel's "Open Settings…" calls `open_settings { section: "ai" }`; Rust shows the
window and emits **`settings-navigate`**, which the Settings frontend uses to select the section.

Two entry points reach the same place and must not diverge: the wheel's Settings wedge goes through
the existing `select_wedge` command, which delegates to the same window-showing helper as
`open_settings` with `section: None`. `settings-navigate` is emitted only when a section is
specified, so the wedge leaves whatever section was last selected in place.

---

## Error handling

- **Corrupt `settings.json`** — fall back to defaults in memory; on the next save, copy the bad file
  to `settings.json.bak` before overwriting. Never silently destroy a file that failed to parse.
- **Missing `settings.json`** — defaults, written lazily on first change.
- **Keychain write failure** — already covered by the read-back verification in `ai::set_api_key`.
- **A `Custom…` model the API rejects** — the existing `{status}: {body}` error path surfaces the
  provider's message verbatim in the panel. No new handling needed.
- **Key removal** — `delete_api_key` wraps `Entry::delete_credential()`. Required: once Settings
  owns keys, "remove" has to exist.

---

## Testing

`settings::load` and `settings::save` take a `&Path` rather than an `AppHandle`, so they are
testable with no Tauri runtime. That seam is also what keeps the module simple to call.

Rust tests, joining the existing `ai::tests::api_key_survives_a_separate_entry`:

1. `defaults_when_file_missing` — absent file yields documented defaults.
2. `round_trips_with_missing_and_unknown_fields` — forward/backward-compat guard for B, C, D.
3. `corrupt_file_falls_back_to_defaults_and_backs_up` — bad JSON yields defaults and produces a
   `.bak` on the next save.

Frontend verification is manual click-through, consistent with current project practice:
open the wheel's Settings wedge, set an OpenAI key, pick `gpt-4o-mini`, confirm the AI panel header
updates live while open, send a message, confirm streaming and insert-into-field.

---

## Out of scope

All other settings sections, the Quit button, and hotkey configuration (B) · onboarding and model
download (C) · packaging and update check (D) · any frontend test runner.
