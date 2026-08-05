# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Tauri v2 (Rust core + React/TypeScript webview frontend), not a native iOS/Android/adaptive app. Windows-first; macOS paths exist in code but are untested (no Mac available for development). -->

## Users

Power users who want voice dictation, quick AI assistance, and quick-capture utilities (screenshot, text snippets, scratchpad) available instantly from anywhere on their desktop, without switching apps or breaking their current flow. The core moment: mid-task in some other application, they need to dictate text, ask an AI something, or capture/insert something quickly, and want that one hotkey press away rather than an app switch + hunt for the right tool.

## Product Purpose

Synapse collapses "I need to do X" (dictate, ask AI, screenshot, insert a snippet, jot a note) down to a single global hotkey (`Ctrl+Alt+Enter`) plus one click. It exists to remove the friction of app-switching for a small set of high-frequency utility actions, and to feel instantaneous when summoned.

## Positioning

A circular radial "pick a slice" menu, summoned system-wide at the cursor position, offering Speech-to-Text, AI chat, Screenshot, Snippet, and Notepad as one flat ring of five wedges — not a command palette, not a docked toolbar, not a set of separate hotkeys/apps to remember. Speech-to-text runs fully local (on-device ONNX model, no cloud round-trip), which a cloud-dictation competitor could not truthfully claim.

## Operating Context

- Global hotkey (`Ctrl+Alt+Enter`) opens the wheel at the mouse cursor from any focused app/window, on top of everything, with no OS window chrome.
- A dedicated direct hotkey starts Speech-to-Text without opening the wheel at all, since it's the most-used action.
- Text produced by Speech-to-Text, AI responses, and Snippets is inserted into whatever field/app had OS focus immediately before the hotkey was pressed, via clipboard paste-and-restore — this does not work into secure-input (password) fields.
- Utility windows (Notepad, Snippet Picker, AI Panel, Settings) are long-lived: they hide rather than close, and can be reopened in the same state.
- First run includes an onboarding flow: OS permission grants (microphone; accessibility/UI-automation for text injection; screen recording on macOS) and the first-run ASR model download (~630MB, resumable).
- Distribution is direct-download only, unsigned/ad-hoc-signed installers — users must bypass Gatekeeper/SmartScreen warnings manually. Updates are notify-only, never silent/automatic.

## Capabilities and Constraints

- **Speech-to-Text**: local transcription via Parakeet TDT 0.6B (ONNX, via `parakeet-rs`), auto-stops on detected silence (RMS energy thresholding, not ONNX VAD), no review/edit step before insertion in v1.
- **AI**: text in, text out, streamed responses only — no computer-use/tool-use/autonomous action in v1. BYOK (user supplies their own Anthropic or OpenAI API key, stored in OS keychain, never in plain settings JSON). No backend proxy or billing.
- **Screenshot**: immediate full-screen capture only, no region-select in v1. Saved to disk + clipboard.
- **Snippet**: reusable text templates, created/managed in Settings, inserted via the same paste-and-restore mechanism.
- **Notepad**: single persistent auto-saving scratchpad, not one note per invocation.
- Menu selection is mouse-only in v1 — no keyboard navigation of the wheel, no nested/sub-menu rings (single flat ring of 5 wedges).
- Explicitly out of scope for v1: autonomous/computer-controlling AI agent, workflow/macro recording, signed/notarized installers, silent updates, multiple/timestamped notes.
- macOS is a real target platform but functionally unverified — treat any macOS-specific claim or behavior as unproven until run on real hardware.

## Brand Commitments

None currently binding. An earlier reference app ("Dyslexic Kit") supplied original visual/structural inspiration for the radial wheel and sectioned-sidebar Settings pattern, but that inspiration has already been absorbed into the current implementation — the implemented UI (not the old reference app) is the visual authority for future design work.

## Evidence on Hand

None (no testimonials, case studies, press, or user research on hand). Do not fabricate any.

## Product Principles

1. Instantaneous over feature-rich — v1 deliberately keeps scope tight (5 wedges, one flat ring, no nesting) rather than maximizing feature count, so the hotkey-to-action path stays fast.
2. Local-first where it matters — speech-to-text runs on-device, not in the cloud, for speed and privacy.
3. Never interrupt the user's typing target — focus capture-and-restore around every overlay/injection ensures the field the user was in before the hotkey keeps working afterward.
4. One design system to perfect, not two — the same visual language and interaction model is expected across Windows and macOS, differing only in unavoidable platform specifics (blur backend, modifier-key labels).
5. Utility windows persist, they don't reset — Notepad, Snippet Picker, AI Panel, and Settings retain state across opens within a session rather than acting like fresh dialogs each time.

## Accessibility & Inclusion

No product-specific accessibility requirement established beyond OS-level permission handling described above.
