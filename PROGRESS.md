# Synapse — Session Handoff

**Last updated:** 2026-08-01
**Status:** M0–M4 complete and manually verified on Windows. M5 sub-project A (Settings
foundation + AI section) is built and automated-verified (build/typecheck/tests all clean);
manual click-through with a real API key is still pending — see "Known gaps" below. M5's
remaining sub-projects (B, C) and M6 (Packaging) not started.

Read `synapse_prd.md` (rewritten this session) and the plan file at
`C:\Users\sahil\.claude\plans\so-i-am-working-ticklish-sunbeam.md` for full context/rationale.
This file is the "what to do next" summary.

---

## Environment facts (don't re-discover these)

- **Windows-only dev machine.** No Mac available — macOS-specific code (`tauri-nspanel`, vibrancy,
  Gatekeeper/TCC behavior) is written but **completely untested**. Treat any macOS claim as unverified.
- Rust toolchain, MSVC build tools, WebView2 are all installed and working.
- **Windows Smart App Control was blocking Cargo build-script binaries** — user disabled it
  (Settings → Privacy & security → Windows Security → App & browser control). If builds start
  failing with `os error 4551` / "Application Control policy has blocked this file", that's back on.
- npm install needs `npm approve-scripts esbuild` once per fresh clone (allow-scripts gate).
- `npm run tauri dev`'s own process output is unreliable to capture (buffers oddly through this
  tool). **Working pattern:** run vite dev server and the built exe as two separate `Start-Process`
  calls, redirecting the exe's stdout/stderr to a log file — this is how every bug this session got
  diagnosed. See "Dev workflow" below.

## Project layout

- App: `C:\Users\sahil\Desktop\Synapse\synapse\` (Tauri v2 + React/TS/Vite)
- PRD: `C:\Users\sahil\Desktop\Synapse\synapse_prd.md` — rewritten to match everything below;
  read it for full rationale on every architectural decision.
- Throwaway ASR proof-of-concept (not part of the app): `C:\Users\sahil\Desktop\Synapse\spikes\asr-spike\`
- Rust source: `synapse\src-tauri\src\` — `lib.rs` (orchestration + all Tauri commands/windows),
  `asr.rs`, `inject.rs`, `notes.rs`, `screenshot.rs`, `snippets.rs`, `ai.rs`, `settings.rs`
- Frontend: `synapse\src\` — `App.tsx` (router by window label), `Wheel.tsx`, `Notepad.tsx`,
  `SnippetPicker.tsx`, `AiPanel.tsx`, `Settings.tsx`, `settings/AiSection.tsx`, `models.ts`,
  `wedges.ts`

## Dev workflow (copy-paste)

```powershell
# Refresh PATH once per new terminal (rustup/cargo aren't on PATH by default in this session)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Kill any running instance
Get-Process -Name synapse -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Build
cd "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
cargo build

# Vite dev server (separate long-running process, only needs starting once)
Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" -WorkingDirectory "C:\Users\sahil\Desktop\Synapse\synapse" -WindowStyle Hidden

# Launch the built exe with logging (this is how every bug got found)
$logPath = "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri\target\debug\synapse.log"
Remove-Item $logPath, "$logPath.err" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri\target\debug\synapse.exe" `
  -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" `
  -WorkingDirectory "C:\Users\sahil\Desktop\Synapse\synapse\src-tauri"
```

Then read `synapse.log` / `synapse.log.err` after reproducing a bug — `println!`/`eprintln!`
calls throughout the Rust code are the primary diagnostic tool.

Hotkeys once running: **Ctrl+Alt+Enter** opens the wheel, **Ctrl+Alt+D** starts dictation directly.

---

## What's built and verified (M0–M4)

**M0 — de-risk spike.** Overlay window + global hotkey work. `parakeet-rs` transcription proven
(1.2s model load, 0.29s to transcribe 11s of audio, CPU-only, word-perfect).

**M1 — radial wheel.** 5-wedge SVG wheel (Speech-to-Text, AI, Screenshot, Snippet, Notepad),
hover states, circular window via SVG shape (not GDI region-clip — that had hard un-antialiased
edges). Click-outside and Esc dismiss.

**M2 — Speech-to-Text.** Mic capture via `cpal`, resamples device's native config (e.g. 48kHz
stereo) to 16kHz mono — requesting 16kHz mono directly from the device fails on real hardware.
Silence detection is simple RMS energy thresholding, **not** the originally-planned ONNX VAD
(`voice_activity_detector` 0.2.0 doesn't compile against the `ort` version `parakeet-rs` pulls in
— upstream incompatibility). "Listening…" pill UI stays visible during capture. Manual stop via
click/Esc. Errors surface in the overlay instead of it silently vanishing. Clipboard paste-and-
restore injection via `enigo` + `tauri-plugin-clipboard-manager`. Direct hotkey bypasses the wheel.

**M3 — Screenshot/Snippet/Notepad.** Screenshot via `xcap` 0.9 (default-resolved 0.3 has a
different/older API — pin to 0.9) → disk (`~/Pictures/Synapse`) + clipboard, with a confirmation
toast (screenshots are otherwise invisible actions). Snippet picker and Notepad are separate
decorated windows. **Routing is by window label, not URL hash** — Tauri escapes `#` in
`WebviewUrl::App`, so hash-based routing silently failed (every window rendered the wheel) — this
cost a full debug cycle, don't repeat it. All three utility windows (Notepad/Snippet/AI) intercept
`CloseRequested` and `hide()` instead of closing — **closing a Tauri window destroys it**, so a
naive close button made windows unreusable.

**M4 — AI panel.** Text chat window, Anthropic + OpenAI both wired via raw HTTP + blocking SSE
line-reader (no official Rust SDK exists — this is the sanctioned fallback per the `claude-api`
skill). Streams via `ai-delta`/`ai-done`/`ai-error` Tauri events. API keys in OS keychain via
`keyring` crate, never in the JSON store. Inline "set API key" UI in the panel itself since
Settings (M5) doesn't exist yet. Model hardcoded to `claude-sonnet-5` / `gpt-4o-mini` — no
model picker UI exists yet.

**`keyring` needs a platform-store feature — silent-failure trap, don't undo this.** Plain
`keyring = "3"` compiles in the crate's in-memory `mock` store on Windows/macOS, and the mock
returns a *fresh empty credential* from every `Entry::new`. Result: `set_api_key` reported
success, `has_api_key` always returned false, the panel stayed on "No key" forever, and Send
stayed disabled (`disabled={streaming || !hasKey}`) — with no error surfaced anywhere. Fixed by
declaring `keyring` with `windows-native` / `apple-native` per-target in `Cargo.toml`. Guarded by
`ai::tests::api_key_survives_a_separate_entry` (`cargo test --lib`) — the only automated test in
the repo — plus a read-back check inside `set_api_key` that errors if the key didn't persist, and
a `try/catch` in `AiPanel.saveKey` that no longer wipes the typed key on failure.

Still needs one end-to-end pass with a real key: send a message, confirm streaming + insert-into-field.

### Focus model (important architectural pivot — see PRD §6.1)

Original plan was a **non-activating** overlay (`WS_EX_NOACTIVATE`) so the wheel would never
steal focus at all. On Windows this broke mouse clicks entirely — Windows silently swallowed them,
and even a `WM_MOUSEACTIVATE` window-procedure subclass didn't fix it (evidence pointed to
Tauri/WRY's own window setup re-subclassing after ours ran). **Pivoted to capture-then-restore**:
`GetForegroundWindow()` before showing any window, `SetForegroundWindow()` back before any text
injection and on dismiss. This is standard for Windows launcher/overlay apps and is far more
robust — costs only that the underlying app's caret stops blinking while a Synapse window is open.

**This has not been validated on macOS.** `tauri-nspanel` non-activation might work fine there
(different OS, different quirk) — worth trying before assuming the Windows workaround is needed.

---

## M5 sub-project A — Settings foundation + AI section (shipped)

Design: `docs/superpowers/specs/2026-08-01-settings-foundation-ai-section-design.md`. Plan:
`docs/superpowers/plans/2026-08-01-settings-foundation-ai-section.md`.

- **`settings.rs`** — hand-rolled JSON store (`Settings { ai: AiSettings }`), mirroring
  `snippets.rs`'s pattern rather than `tauri-plugin-store` (the repo doesn't use it, despite PRD
  §6.4 implying one). `load`/`save` take a `&Path`, so they're unit-tested with no Tauri runtime:
  defaults on missing file, forward/backward-compat with unknown/missing fields (for B/C/D to add
  sections later), corrupt file falls back to defaults and is backed up to `.bak` before being
  overwritten. 3 new tests, joining the existing `ai::tests::api_key_survives_a_separate_entry`
  (4 total, `cargo test --lib`).
- **6th wheel wedge → Settings window.** New `settings` wedge (ring geometry is count-driven, no
  layout work needed). Settings window follows the established hidden-on-close pattern (Notepad/
  SnippetPicker/AiPanel) — closing it hides, never destroys.
- **`get_settings`/`update_settings`/`open_settings`/`delete_api_key` commands.** `update_settings`
  writes the file then broadcasts `settings-changed` — required because the AI panel is only ever
  hidden, never closed, so it can't be relied on to re-read config next time it's shown.
  `open_settings(section)` is the single entry point both the wheel wedge and the AI panel's
  deep-link funnel through, so they can't drift apart; it emits `settings-navigate` when a section
  is specified.
- **Settings frontend** — `Settings.tsx` (sidebar shell, currently one "AI" row — B adds more as
  they're built, no placeholder rows for unbuilt sections), `settings/AiSection.tsx` (provider
  select, per-provider model picker with a curated dropdown + "Custom…" free-text escape hatch,
  API key save/remove), `models.ts` (shared `Provider`/`Settings` types + model catalog).
- **AI panel stripped down.** `AiPanel.tsx` no longer owns provider/model/key state — it reads
  `get_settings`, listens for `settings-changed` to stay live while open, and shows a read-only
  `Provider · model` header. A missing key now shows an actionable "Open Settings…" button
  (`open_settings({ section: "ai" })`) instead of a dead-end inline key form.
- **`ai.rs` no longer hardcodes models.** `ANTHROPIC_MODEL`/`OPENAI_MODEL` consts are gone;
  `stream_chat` takes a resolved `model: &str` argument. `send_ai_message` (in `lib.rs`) loads
  settings and resolves `model_for(provider)` before calling it — `ai.rs` stays a pure HTTP/SSE
  module with no file I/O. Anthropic `max_tokens` raised 4096 → 16000: on `claude-opus-5` (now
  reachable via the model picker) extended thinking is on by default and `max_tokens` caps
  thinking *plus* response text, so the old limit would truncate mid-answer.
- **API keys still never touch `settings.json`** — `Settings`/`AiSettings` carry no key fields;
  key management goes through the OS keychain via `set_api_key`/`delete_api_key` only.

**Consequence to carry into sub-project B:** choosing the wheel wedge over a tray icon leaves the
app with no quit path. B's General or About section must add an explicit "Quit Synapse" button.

**Verified automated:** `cargo test --lib` (4 passed), `cargo build` (clean), `npx tsc --noEmit`
(clean), and the built exe launches cleanly with the new wedge/window wired up (confirmed via the
dev-workflow log — no crash, no missing-window errors).

**Not yet verified — needs a human pass with a real API key:** the full interactive flow (open
Settings from the wheel, save a real OpenAI/Anthropic key, pick a model, confirm the AI panel
header updates live while open when Settings changes it, send a message and confirm streaming +
insert-into-field, remove a key and confirm the panel's empty state + deep-link back to Settings,
a `Custom…` model that the API rejects surfaces a real error, and that provider/model/key persist
across a relaunch). This wasn't done in this session because it requires typing a real key and
driving the desktop UI interactively — see the plan's Task 6 Step 2 for the full checklist.

## Known gaps / not yet done

- **M5 sub-project A manual verification** — see above.
- **M5 sub-project B — remaining settings sections.** General (dynamic hotkeys, launch at login,
  **Quit Synapse button** — see consequence above), Microphone, Capture, Snippets CRUD, Voice/ASR,
  Permissions, About. Not started.
- **M5 sub-project C — onboarding + model download.** No first-run permission-grant flow. ASR
  model is loaded from a hardcoded local `model/` directory copied in during dev — production
  needs to download it on first run (PRD §6.2) with a progress UI. Ship-blocker: the app cannot
  currently be installed by anyone else. Not started.
- **M6 — Packaging.** No `.dmg`/`.msi` build has been attempted. Ad-hoc signing for macOS, update
  check against GitHub releases, install docs — all still TODO.
- macOS is entirely unverified — every macOS-specific code path (`#[cfg(target_os = "macos")]`,
  vibrancy, `tauri-nspanel`) needs testing on real hardware.
- No frontend automated tests exist (by design for sub-project A — see the design doc's "Out of
  scope"); Rust has 4 unit tests (`settings.rs` × 3, `ai.rs` × 1). Everything else is manual
  click-through.

## Next steps, in order

1. Manual click-through of M5 sub-project A with a real API key (see above) — confirms the
   settings foundation before building on top of it.
2. M5 sub-project C next (per the agreed A → C → B → D build order): onboarding wizard, 640 MB
   resumable model download with progress, move ASR off its hardcoded relative path. This is the
   ship-blocker.
3. M5 sub-project B: the remaining settings sections, including the Quit button.
4. M6: packaging for Windows (`.msi`) at minimum; macOS packaging blocked on having a Mac to test.
5. Whenever a Mac becomes available: validate the entire macOS code path before assuming any of
   it works — vibrancy, focus behavior, Gatekeeper/TCC flow, permissions.
