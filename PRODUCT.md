# Product

<!-- impeccable:product-schema 1 -->

## Platform and users

Synapse is a Windows-first Tauri desktop utility for people who want dictation, AI assistance, notes, clipboard history, and screenshots without leaving the app they are using. Windows is tested; macOS code is unverified. The shipped installer is Windows x64.

## Core interaction

The default `Ctrl+Alt+Enter` shortcut opens a radial menu at the cursor. A separate shortcut starts dictation directly. Both can be changed in Settings → Controls. The wheel exposes eight actions: Speech-to-Text, AI, Screenshot, Clipboard, Notepad (Notes Hub), Speak Selected Text, Settings, and Force Quit. The visible wheel tools, accent, and size are configurable.

Synapse captures the previously focused window and restores it before inserting text. Dictation runs locally with the optional Parakeet model and stops when the user chooses to finish; automatic silence stop is an opt-in setting. Screenshot captures the current monitor and saves a PNG under `Pictures/Synapse`. Clipboard history can be searched, pinned, limited, disabled, and cleared. Notes support folders, rich editing, sticky windows, and Recently Deleted.

The AI orb streams replies and can speak them. Anthropic, OpenAI, and OpenRouter use the user's own keys, kept in the OS credential store. AI conversations and usage are stored locally; assisted desktop actions are available with controls for consequential actions. The optional local voice engine is downloaded separately, with an OS voice fallback.

## Product principles

1. Return the user to their original task quickly; the wheel is an action launcher, not a destination.
2. Keep local features local where practical. Be explicit when provider requests or assisted desktop actions share context externally.
3. Preserve the user's typing target and existing data across app windows and updates.
4. Let the user choose when to download models, enable clipboard history, and install signed updates.
5. Use one token-based visual system across the overlay and utility windows, with accessible controls and clear state.

## Distribution and limits

The Windows NSIS installer is signed through the maintainer's GitHub release workflow, which also publishes the update manifest. Existing installations check **Settings → Updates** and install only artifacts verified by the pinned updater key. macOS behavior, packaging, and permissions still need testing on real hardware. There is no Synapse cloud account or hosted AI proxy; users supply their own provider keys.

Current behavior is documented in [README.md](README.md). The [original v1 PRD](synapse_prd.md) is historical and does not describe the current feature set.
