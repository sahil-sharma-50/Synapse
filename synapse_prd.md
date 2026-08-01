# Synapse — Product Requirements Document (v1)

**Status:** Draft for review
**Owner:** [TBD]
**Last updated:** 2026-07-31

---

## 1. Overview

Synapse is a cross-platform (macOS + Windows) desktop utility that puts voice dictation, quick AI assistance, and quick-capture tools one hotkey away. Pressing `Ctrl+Alt+Enter` summons a circular radial menu at the current mouse position, letting users pick an action with a single click — no app switching, no typing a command.

**Core pillars for v1:**
1. **Speech-to-Text** — instant local voice dictation into any focused field
2. **AI Assistance** — a text-based AI chat panel, one hotkey away
3. **Capture** — quick utilities: Screenshot, Snippet (text templates), Notepad (scratchpad)

v1 is deliberately scoped tight: get the app running well and looking good on both platforms, rather than maximizing feature count. Autonomous computer-control ("AI Agent" in the sense of an agent that clicks, types, and runs commands on the user's behalf) and workflow/macro recording are both real ideas for a future version, but neither is part of this document.

---

## 2. Goals & Success Criteria

- Reduce the time from "I need to do X" to "X is done" for dictation, quick AI assistance, and capture actions to a single hotkey + click.
- Ship a usable, installable build on both macOS and Windows that other users (not just the developer) can download and run.
- Keep v1 scope tight: 5 wedges in a single flat ring, no nested menus, no macro/workflow system.
- The app should feel instantaneous when hotkey-summoned and should look like a polished, native-feeling macOS utility, with an equivalent look and feel on Windows.

---

## 3. Reference / Design Inspiration

Visual and structural inspiration was pulled from an existing macOS utility ("Dyslexic Kit"):
- **Radial "pick a slice" menu**: dark background, thin wedge dividers, icon + number per slice, center hub shows a hint label ("Pick a slice") and an `esc` cancel affordance. Synapse's menu should follow this same visual language — circular, high-contrast, icon-forward, minimal chrome.
- **Settings panel structure**: a left-hand sidebar grouping settings into logical sections (General Settings, Shortcuts, Modes, Microphone, Models, Voices, AI, Permissions, etc.). Synapse's own preferences window should follow a similar sectioned-sidebar pattern rather than one long settings page.

**Design direction for v1:** one design, built to macOS conventions (typography, spacing, motion, vibrancy) and rendered identically on Windows — only the blur backend (`NSVisualEffectView` vs. Mica/Acrylic) and modifier-key labels (`⌘`/`⌥` vs. `Ctrl`/`Alt`) differ between platforms. This keeps the design effort to a single system to perfect, rather than two.

---

## 4. User Interaction Flow

### 4.1 Invocation
- Global hotkey: **`Ctrl+Alt+Enter`** (must work system-wide, regardless of focused app)
- On trigger, the circular menu appears **centered on the current mouse cursor position**
- Window is always-on-top, transparent background outside the circle, no OS window chrome
- Dismiss via `Esc`, clicking outside the circle, or completing a selection
- **Focus handling:** the overlay activates normally while open (so clicks and `Esc` work reliably), but the app captures whichever field/window was focused immediately before the hotkey was pressed. That focus is restored right before any text is injected (Speech-to-Text, Snippet, AI insert) and when the overlay is dismissed, so the user's typing target is preserved even though it briefly loses the blinking caret while the wheel is open. See §6.1 for why this replaced an earlier "never take focus" design.

### 4.2 Menu Structure

**A single flat ring of 5 wedges:**

| Wedge | Icon concept | Action |
|---|---|---|
| Speech-to-Text | Microphone | Starts local voice transcription immediately |
| AI | Sparkle icon | Opens the AI chat panel |
| Screenshot | Camera | Instant full-screen capture |
| Snippet | Text/Abc icon | Opens searchable list of saved text snippets |
| Notepad | Note icon | Opens the persistent scratchpad |

Selection is **mouse-only** for v1 (click a wedge). No keyboard navigation of the wheel itself (number-key shortcuts may be a natural v2 addition, following the reference app's numbered-slice pattern). There is no nested/sub-menu ring in v1 — every action is one hotkey press + one click.

### 4.3 Feature Behaviors

**Speech-to-Text**
- Reachable two ways: selecting the wedge, or a **dedicated direct hotkey** that starts dictation without opening the wheel at all (the most-used feature shouldn't cost an extra click)
- Recording begins immediately on invocation; the wheel (if open) collapses into a small floating pill near the cursor showing a live waveform / recording state
- Audio is transcribed **locally** using the Parakeet ASR model (see §6.2)
- Recording **auto-stops on detected silence** (local voice-activity detection), or can be stopped early by clicking the pill; `Esc` cancels without transcribing
- Transcribed text is inserted into whatever field currently has OS focus via clipboard paste-and-restore (see §6.4) — no intermediate review/edit step in v1

**AI**
- Selecting the wedge opens a small floating chat panel
- Text in, text out: the user types (or dictates) a prompt and receives a streamed response
- The response can be inserted into the currently focused field, the same way Speech-to-Text and Snippet insert text
- The AI **does not control the computer** in v1 — no clicking, typing into other apps, running commands, or browsing on the user's behalf. That capability is an explicit candidate for a future version, not v1
- User selects their preferred LLM provider (Anthropic Claude or OpenAI) in Settings; both are supported from day one since both expose comparable text/streaming APIs

**Screenshot**
- Selecting the wedge **immediately** captures the full screen (no region-select step in v1)
- Result is saved to disk (default location, configurable in Settings) and copied to the clipboard

**Snippet**
- A **reusable text template manager**. Selecting the wedge opens a searchable list/picker of previously saved snippets
- Picking a snippet **inserts/types it into the currently focused field**, via the same clipboard paste-and-restore mechanism as Speech-to-Text
- Snippets are created and managed from the Settings panel (create, edit, delete, search)

**Notepad**
- Opens a **single, persistent, auto-saving scratchpad window**
- Same note every time — not a new note per invocation. Content persists across app restarts

### 4.4 Text Injection

Speech-to-Text, Snippet, and AI-response-insertion all share one mechanism: the app saves the current OS clipboard contents, writes the target text to the clipboard, synthesizes a paste keystroke (`Cmd+V` / `Ctrl+V`) into the previously-focused field, then restores the original clipboard contents. This is fast regardless of text length, handles unicode/emoji correctly, and works across native, web, and Electron-based apps. It will not work into secure-input fields (e.g. password boxes), which is an accepted limitation.

---

## 5. Settings / Preferences Panel

Following the sectioned-sidebar pattern from the reference app, Settings should be organized into groups such as:

- **General** — launch at login, show in dock/menu bar/tray, hotkey configuration
- **Microphone** — input device selection, noise suppression toggle
- **Voice / ASR** — model info, language settings (Parakeet is multilingual with auto language detection)
- **AI** — provider selection (Anthropic / OpenAI), API key entry (BYOK), model selection
- **Snippets** — create/edit/delete saved text templates
- **Capture** — screenshot save location, format
- **Permissions** — OS-level permission status (microphone, screen recording, accessibility/automation) with links to grant them, and **self-serve recovery steps** for when a permission grant is lost after an app update (see §8)
- **About** — version info, update-check status

---

## 6. Technical Architecture

### 6.1 Application Framework

**Decision: Tauri v2 (Rust core + web-based frontend)**

Rationale:
- Cross-platform (macOS + Windows) from a single codebase
- First-class support for transparent, always-on-top, chromeless windows — required for the circular overlay
- First-class global hotkey APIs
- Significantly lighter resource footprint and faster startup than Electron — important for a tool that must feel instantaneous when hotkey-summoned
- Frontend is standard HTML/CSS/JS (React + TypeScript in this case), giving full design control to match the target radial-menu aesthetic
- Rust core is a better neighbor for CPU/GPU-intensive local work (like ASR inference) than a Node/Electron main process

**Focus handling — capture and restore, not non-activating:** the original plan called for a non-activating overlay window (`WS_EX_NOACTIVATE` on Windows) so the wheel would never take focus at all. Prototyping this on Windows (M0) found that Tauri/WRY's window setup fights a `WS_EX_NOACTIVATE` + `WM_MOUSEACTIVATE`-subclass approach badly enough that mouse clicks stopped being delivered to the window entirely, with no workaround found that didn't fight the framework. The overlay instead activates normally when shown (so clicks and `Esc` work exactly as expected), and the app records the previously-focused window (`GetForegroundWindow` on Windows) right before showing the overlay, restoring it (`SetForegroundWindow`) before any text injection and on dismiss. This is the pattern most Windows overlay/launcher tools use, is far more robust, and costs only a cosmetic detail: the underlying app's caret stops blinking while the wheel is open, resuming exactly where it was once focus is restored. The macOS side still needs its own validation — `tauri-nspanel` (`NSPanel` + `NSWindowStyleMaskNonactivatingPanel`, app `ActivationPolicy::Accessory`) is untested and macOS may not hit the same WRY quirk, so the non-activating approach remains worth trying there before falling back to the same capture-and-restore pattern.

**Consequence of transparency:** achieving the transparent circular window requires `macOSPrivateApi: true` in the Tauri config, which permanently disqualifies the app from Mac App Store distribution. Since v1 distribution is direct-download only (see §8), this has no practical cost, but it is a one-way door worth recording.

Rejected alternatives:
- **Electron**: same UI flexibility, but heavier (memory/disk/startup time), which works against the "instant overlay" goal
- **Native per-platform (Swift/SwiftUI + C#/WinUI)**: best possible performance/OS integration, but doubles v1 build and maintenance effort — not justified at this stage

### 6.2 Speech-to-Text: Parakeet ASR

**Model:** NVIDIA Parakeet TDT (0.6B parameters), multilingual with auto language detection.

**Deployment decision:** Run the model **in-process, in the Rust core**, as an ONNX model via the `parakeet-rs` crate (ONNX Runtime under the hood — DirectML/CUDA on Windows, WebGPU/Metal on macOS, with automatic CPU fallback). Local voice-activity detection (Silero VAD, also via ONNX) runs on the live microphone stream to detect silence and trigger the transcription pass; TDT 0.6B itself is used as an offline (non-streaming) model over the buffered utterance.

Why this approach over a Python sidecar:
- **No second process.** A bundled Python interpreter + NeMo/Transformers sidecar, communicating over local IPC/HTTP, adds a process to supervise, a multi-second cold start, and a large distribution footprint
- **Small installer.** The ONNX model is on the order of a few hundred MB, downloaded on first run (see below) rather than bundled — the installer itself stays small
- **Fast on both platforms.** GPU acceleration is available on macOS via Metal/WebGPU and on Windows via DirectML/CUDA, avoiding the CPU-only-on-Mac slowdown that a NeMo/Transformers-based sidecar would hit (NeMo/Transformers do not reliably accelerate on Apple Silicon)
- **Rust-native.** `parakeet-rs` is published on crates.io and built to be embedded directly in a Rust application, which fits the Tauri core without any cross-process boundary

**Model delivery:** the model is **not bundled in the installer**. On first run, as part of onboarding, the app downloads the model with a visible progress indicator. This keeps the installer itself small and lets model updates ship independently of app updates. Requires internet connectivity on first run; a failed/interrupted download must be resumable or retryable from the onboarding UI.

**Known risk — accepted for v1:** `parakeet-rs` is a community-maintained crate, not an NVIDIA-official SDK. It is the best available path to a fast, embeddable, cross-platform ONNX runtime for this model today, but it is a load-bearing third-party dependency and should be pinned and monitored for breaking changes.

### 6.3 AI

- **Providers:** Anthropic Claude and OpenAI, both supported from day one — user selects one in Settings
- **Capability:** text in, text out (streamed responses) only. No computer-use / tool-use / autonomous action in v1
- **Authentication/billing: BYOK (Bring Your Own Key)** — each user supplies and pays for their own API key. Synapse has no backend proxy, billing system, or usage metering in v1
- **Key storage:** API keys are stored in the OS-native credential store (macOS Keychain / Windows Credential Manager via the `keyring` crate) — never written to the plain JSON settings store

### 6.4 Screenshot, Snippet, Notepad

- **Screenshot:** OS-level screen capture, saved to disk + clipboard
- **Snippet:** Local JSON store (via `tauri-plugin-store`) of user-created text templates, with a lightweight search/filter UI in the picker
- **Notepad:** Single persistent note, auto-saved locally on every change (debounced), reopened with prior content on each invocation

---

## 7. Platform & Permissions Requirements

Both macOS and Windows require explicit OS-level permission grants for core functionality:
- **Microphone access** — required for Speech-to-Text
- **Screen recording permission** (macOS) — required for Screenshot
- **Accessibility permissions** (macOS) and equivalent UI-automation permissions (Windows) — required for **both** Speech-to-Text and Snippet, since inserting transcribed/snippet text into the focused field requires synthesizing a paste keystroke into another application

**Requirement:** v1 must include a **first-run onboarding flow** that walks the user through granting each required permission, with clear explanations of why each is needed, plus the first-run model download (§6.2). This mirrors the reference app's dedicated "Permissions" settings page, with a proactive first-run version of it.

**Requirement — permission recovery:** because v1 ships unsigned (§8), macOS may silently drop a previously-granted Accessibility permission after an app update. The Permissions settings page must detect this state and walk the user through re-granting it, rather than leaving Speech-to-Text/Snippet silently non-functional.

---

## 8. Distribution

- Shipping to external users via a direct download link (not the App Store, not internal-only) — this is a real product release
- **Installers: unsigned for v1** on both macOS (.dmg) and Windows (.exe/.msi). The macOS build is ad-hoc signed (free, via `codesign -s -`), which is strictly better than a bare unsigned bundle but does **not** grant the persistence benefits of a paid Apple Developer signature
- Users will see OS security warnings and must manually bypass them:
  - **macOS:** Gatekeeper blocks the app; as of macOS Sequoia/Tahoe, the Control-click bypass is gone, so users must go to System Settings → Privacy & Security → "Open Anyway" (and, on Tahoe, enter an admin password)
  - **Windows:** SmartScreen shows an "unrecognized app" warning with a "Run anyway" option
- **Known, accepted tradeoff:** macOS ties permission grants (Accessibility, Microphone, Screen Recording) to the app's code signature. Because v1 is ad-hoc signed rather than signed with a paid Apple Developer identity, **an app update can cause macOS to forget a previously-granted Accessibility permission**, silently breaking Speech-to-Text and Snippet until the user re-grants it. This is accepted for v1; the Permissions settings page must make recovery self-serve (§7). Signing with a paid Apple Developer identity ($99/year) is the fix and can be revisited once the app has traction
- **Updates:** notify-only. The app periodically checks GitHub releases and shows an "update available" badge in Settings linking to the new download — no silent/automatic install. This is deliberate given the permission-reset risk above: an update should be a moment the user is aware of, not something that happens invisibly and then breaks dictation

---

## 9. Known Risks & Open Questions

| Risk / Open Item | Notes |
|---|---|
| `parakeet-rs` is a community dependency | Not an NVIDIA-official SDK. Best available embeddable ONNX path today; pin the version and monitor for breakage. |
| macOS focus/activation behavior untested | The Windows overlay uses capture-and-restore (§6.1), not non-activation, after `WS_EX_NOACTIVATE` proved incompatible with reliable click delivery under WRY. Whether `tauri-nspanel`'s non-activating approach works cleanly on macOS, or needs the same capture-and-restore fallback, is still unverified — no Mac available for this project's development so far. |
| Unsigned/ad-hoc macOS build drops Accessibility permission on update | Accepted tradeoff (§8). Mitigated by an in-app recovery flow, not eliminated. Revisit paid Apple Developer signing post-launch. |
| First-run model download | Requires internet on first run; needs resumable/retryable download handling so a flaky connection doesn't strand onboarding. |
| Gatekeeper/SmartScreen friction | Unsigned installers mean every new user must manually bypass an OS warning. May reduce install completion for less technical users. |
| `macOSPrivateApi: true` blocks App Store distribution | One-way door, but consistent with the direct-download distribution model already chosen. |

---

## 10. Explicitly Out of Scope (v1)

- Autonomous / computer-controlling AI agent (clicking, typing into other apps, running terminal commands, browsing on the user's behalf) — candidate for a future version
- Workflow Start / Record Workflow (macro recording and replay) — candidate for a future version
- Keyboard-only navigation of the radial menu
- Nested/sub-menu rings (v1 is a single flat ring of 5 wedges)
- Screenshot region-select or window-capture modes (full-screen only in v1)
- Backend billing/proxy for API usage (BYOK only)
- Signed/notarized installers (paid Apple Developer signing, Windows code-signing certificate)
- Silent/automatic updates (notify-only in v1)
- Multiple/timestamped notes (Notepad is a single persistent note in v1)

---

## 11. Next Steps

1. Review and approve this PRD
2. Proceed with implementation per the milestone plan (M0 de-risk spike through M6 packaging)
