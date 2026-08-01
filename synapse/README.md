# synapse

The app. Tauri v2 (Rust) backend, React/TypeScript/Vite frontend.

## Layout

- `src/` - frontend. See `src/` files directly, no separate README there; `App.tsx` routes by window label.
- `src-tauri/` - Rust backend. See `src-tauri/README.md`.
- `index.html`, `vite.config.ts`, `tsconfig.json` - Vite/TS project config.

## Commands

```bash
npm install
npm approve-scripts esbuild   # one-time
npm run dev                   # Vite dev server only
npm run tauri dev             # Vite dev server + Tauri app window
npm run build                 # tsc + vite build (frontend only)
npm run tauri build           # full production build, produces the installer
```

See the root `CLAUDE.md` for architecture notes (window routing, focus model, settings persistence, AI streaming, ASR).
