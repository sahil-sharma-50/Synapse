# Microsoft Store listing: Synapse Voice

Partner Center product **9PDDK7S60F73** (`SahilSharmaStudios.SynapseVoice`).
Paste these into **Store listings → English (United States)**. Keep claims in
step with README.md: don't promise anything the shipped build doesn't do.

## Product name

Synapse Voice

## Short description

Partner Center shows the character limit next to the field.

Private voice typing for Windows. Press a shortcut, speak, and your words are typed into any app. Speech recognition runs on your PC, so dictation works offline. Clipboard history, notes, screenshots and an AI assistant sit one shortcut away.

## Description

Synapse Voice puts dictation and everyday desk tools one shortcut away.

Press Ctrl+Alt+D anywhere and start talking. Synapse transcribes on your own PC with a local speech model and types the text into the app you were using: email, chat, documents, code editors, browsers. Your voice is not uploaded for dictation, and it keeps working without an internet connection.

Press Ctrl+Alt+Enter to open the Synapse wheel at your cursor:

• Speech-to-Text: local dictation into the app you were just using
• AI: a voice assistant that streams and speaks replies (bring your own Anthropic, OpenAI or OpenRouter key; keys are stored in the Windows credential store)
• Clipboard: searchable, pinnable clipboard history you can turn off or clear
• Notepad: rich notes, folders and sticky notes
• Screenshot: capture the monitor under your cursor to a PNG and the clipboard
• Speak Selected Text: read any selected text aloud

Make it yours: change shortcuts, choose which tools appear on the wheel, and pick its size and accent colour.

Privacy: dictation, notes, clipboard history and AI conversation history stay on your PC. AI requests go only to the provider whose key you add. The local speech model (about 630 MB) downloads on first use, when you choose.

## What's new in this version

First Microsoft Store release.

## Product features (one per line, ≤ 200 characters each)

Offline speech-to-text that types into any app
Radial menu at your cursor with one shortcut
Searchable clipboard history with pinning
Rich notes and sticky notes
Voice AI assistant with your own API key
Read selected text aloud
Customisable shortcuts, tools and colours

## Search terms (up to 7)

dictation
voice typing
speech to text
offline dictation
clipboard manager
voice assistant
productivity

## Screenshots

The five uploaded screenshots (1920×1080) are in `screenshots/`. They were taken
from a build with a separate identifier (`--config '{"identifier":"com.synapse.storeshots"}'`)
so no real notes or clipboard history could appear, over a plain backdrop, then
captioned. Retake them when the UI changes. A screenshot of dictation actually typing
into an app would be a stronger first image than the wheel.

## Submission options → restricted capability justification (runFullTrust)

Synapse Voice is a Win32 desktop utility (Tauri/Rust) packaged with MSIX. It needs
runFullTrust to register system-wide keyboard shortcuts that open its menu over
any app, to restore focus to the previously active window, and to type dictated
text into that window using the clipboard and simulated paste. It also reads
clipboard history the user has enabled and captures screenshots of the monitor
under the cursor. None of this is possible from an app container.

## Notes for certification (Submission options)

No account or sign-in is required. To test dictation: launch the app, finish
onboarding (it offers the optional ~630 MB speech model download), open Notepad,
press Ctrl+Alt+D, speak, then press Enter. The AI feature needs the tester's own
API key and is optional; every other feature works without one. Updates are
delivered through the Store. The in-app updater is disabled in the MSIX build.
