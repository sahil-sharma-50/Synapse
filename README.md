# Synapse

<p align="center">
  <img src="assets/synapse.png" alt="Synapse product screenshot" width="720" />
</p>

Synapse is a desktop utility that puts voice dictation, quick AI assistance, and quick-capture tools one hotkey away. Pressing `Ctrl+Alt+Enter` summons a circular radial menu at the current mouse position, letting you pick an action with a single click, no app switching, no typing a command.

Windows is the supported and tested platform. macOS code paths exist but are currently **untested** — treat macOS support as unverified.

## Download

**[Download the latest Windows installer](https://github.com/sahil-sharma-50/Synapse/releases/latest)** — grab the `Synapse_*_x64-setup.exe` asset and run it. First-run setup guides you through microphone access and optional speech downloads. You can skip downloads and start them later in Settings → Voice.

## Features

The radial menu has eight actions:

- **Speech-to-Text** - instant local voice dictation into any focused field
- **AI Assistance** - a text-based AI chat panel, one hotkey away
- **Screenshot** - region capture saved to `Pictures/Synapse`
- **Snippet** - saved text templates, inserted into the focused field
- **Notepad** - a persistent scratchpad
- **Speak Selected Text** - reads your current text selection aloud (optional local voice engine)
- **Settings** - shortcuts, AI provider/model selection, voice options, and app preferences
- **Force Quit** - fully exits Synapse to free up background resources; relaunch from the app icon

Synapse also lives in the system tray, which offers Open, Dictate, Settings, and Quit.

Built with [Tauri](https://tauri.app/) (Rust) and React/TypeScript.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- On Windows: [Microsoft Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (usually preinstalled)
- On macOS: Xcode Command Line Tools

## Running locally

```bash
cd synapse
npm install
npm approve-scripts esbuild   # one-time, allows esbuild's install script to run
npm run tauri dev
```

This starts the Vite dev server and launches the Tauri app window. On first run, grant any OS permissions prompted (microphone access, accessibility, etc.) for dictation and text injection to work.

To build a production bundle (produces the versioned installer in `synapse/src-tauri/target/release/bundle/nsis/` on Windows):

```bash
npm run tauri build
```

Release builds require `TAURI_SIGNING_PRIVATE_KEY` for updater artifacts. For a local installer without updater signing, use `npm run tauri build -- --config src-tauri/tauri.pr-build.conf.json`.

## Speech-to-Text model

Local dictation uses the [Parakeet TDT 0.6B v2](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx) ONNX model (int8 variant, ~630 MB). It isn't checked into this repo. Start the resumable download during setup or in Settings → Voice. Models are stored under `%APPDATA%\com.synapse.app\model\` on Windows.

`synapse/src-tauri/model/` is gitignored, so this happens once per machine.

## Speak Selected Text (optional)

"Speak Selected Text" is powered by a self-contained local voice engine and is **optional** — skip it during onboarding and everything else still works. Enabling it downloads a standalone Python runtime plus `torch` (CPU) and `pocket-tts` into your app data directory, roughly 1-2 GB in total. Setup runs in three stages (Python runtime → packages → voice model) with a progress meter, and can be started or retried later from **Settings → Voice**.

Nothing is installed system-wide: it all lives under `%APPDATA%\com.synapse.app\tts-env\`, so deleting that folder fully removes it.

## Project structure

- `synapse/src` - React/TypeScript frontend
- `synapse/src-tauri` - Rust backend (Tauri commands, audio, AI, settings)
- `synapse_prd.md` - product requirements and design rationale
- `spikes/` - standalone proofs of concept, not part of the shipped app

## License

See [LICENSE](LICENSE).
