# Synapse app

Tauri v2 desktop app with a Rust backend and React/TypeScript/Vite frontend. The root [README](../README.md) describes current features and downloads; [CONTRIBUTING](../CONTRIBUTING.md) covers setup and pull requests.

## Layout

- `src/` — frontend. `App.tsx` routes by Tauri window label; `theme.css` owns visual tokens; `settings/` contains Settings sections. See [frontend agent guidance](src/AGENTS.md).
- `src-tauri/` — Rust commands, windows, audio, persistence, and updater. See [Rust README](src-tauri/README.md).
- `public/` — static assets, including the orb microphone worklet.

## Commands

```powershell
npm ci
npm run tauri dev     # Vite and the desktop app
npm run typecheck
npm run lint
npm run test
npm run build          # frontend production build
npm run guards        # repository invariants
```

On a fresh install, run `npm approve-scripts esbuild` if npm prompts. A local Windows installer without the release signing secret can be built with `npm run tauri build -- --config src-tauri/tauri.pr-build.conf.json`. Signed releases are built only by `.github/workflows/release.yml`.
