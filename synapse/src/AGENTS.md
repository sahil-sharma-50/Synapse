# Frontend and UI guidance

Read the root [AGENTS.md](../../AGENTS.md) and [DESIGN.md](../../DESIGN.md) first. `theme.css` and the existing components are the visual source of truth.

- Keep the radial menu fast to scan and utility windows task focused. Use the existing window-label routing in `App.tsx`; do not route by URL hash.
- Use `--sy-*` tokens from `theme.css` for color, spacing, type, radius, elevation, and motion. Add a missing token there instead of a local raw hex or bare pixel gap. Keep `noteColors.ts` aligned with Rust's `notes::COLORS`.
- Reuse the shared controls and patterns in Settings, Notes Hub, Clipboard, and the AI orb. Keep control labels, status text, and errors specific enough to act on.
- Use semantic controls, accessible names, visible keyboard focus, and live status only where a status actually changes. Check tab order, narrow windows, and `prefers-reduced-motion`.
- Keep indeterminate progress meters' fill child (`.set-meter-fill` or `.ob-meter-fill`); the animation is on that child. Show real progress when bytes are known.
- Utility windows with fixed labels hide on close so they can reopen. Onboarding and individual sticky notes are the deliberate exceptions.
- Run `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, and the repo guards for UI changes. Check touched files with Prettier and inspect the UI in the running app when layout or interaction changed.
