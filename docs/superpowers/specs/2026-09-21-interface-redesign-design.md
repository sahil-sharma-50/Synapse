# Synapse Interface Redesign

## Intent

Make Synapse feel like a compact, professional desktop utility that disappears into the user's workflow. Preserve every existing feature, route, setting, error state, keyboard behavior, and persistence rule. Change presentation and the voice-selection interaction only.

Success means:

- the radial menu feels substantially smaller and faster to scan;
- onboarding communicates one decision per step without card clutter;
- settings are easy to navigate and visually quiet even when a section contains many controls;
- choosing a local voice immediately plays that voice and saves the choice;
- all affected surfaces remain keyboard accessible and respect reduced motion.

## Direction

Use a restrained Windows-first dark utility language. Keep Segoe UI Variable, the blue accent, the existing icon family, and the single dark theme. Replace decorative gradients, glows, and repeated elevated cards with solid neutral surfaces, sparse separators, precise alignment, and short state transitions.

Design dials:

- Design variance: 5. Familiar desktop structure with a distinctive radial launcher.
- Motion intensity: 4. Fast state transitions and entrance feedback, never ambient spectacle.
- Visual density: 5. Compact enough for a utility, with enough whitespace to remain calm.

No new frontend dependency or design-system package is needed. Existing React, TypeScript, native CSS, Tauri APIs, and shared tokens cover the work.

## Radial menu

Reduce the transparent Tauri overlay from 360 by 360 to 304 by 304. Render the wheel with an outer radius of 126, inner radius of 50, and icon radius centered between them. Keep all eight actions in their current order and preserve the center hub as both dismiss target and drag handle.

The wheel uses one opaque neutral ring, very subtle slice separators, 20-pixel icons, and a compact center label. Hover changes the active slice with the existing blue accent and slightly lifts the icon using transform only. Force Quit keeps its red hover treatment. The launch transition is a short opacity and 0.96-to-1 scale settle. Reduced-motion users receive the final state immediately.

Listening, speaking, success, and error states shrink with the overlay. Their shared circle becomes 176 by 176 while retaining the real microphone meter, timer, stop control, and current event behavior.

## Onboarding

Keep the five existing steps and their behavior:

1. Welcome
2. Microphone
3. Dictation model
4. Read aloud
5. Finish

Use a compact header with the Synapse wordmark, current step name, and a thin progress track. Do not show five equally weighted numbered badges at all times. Each screen has one heading, one short explanation, and one task area. Welcome and Finish may use the existing product mark; intermediate steps use their functional content as the visual focus.

Use flat task panels with one separator hierarchy, clear installed/not-installed language, and a single primary action. Downloads keep determinate and indeterminate progress, transfer details, retry behavior, and the ability to continue while downloading. The footer stays fixed with Back and the context-specific primary action. Step transitions use opacity and an 8-pixel vertical settle.

The final readiness summary remains factual and separately reports dictation, microphone, and read-aloud readiness. No setup capability becomes mandatory if it is currently optional.

## Settings

Keep the existing 860 by 640 window and four destinations: AI, Voice, Clipboard, and Updates. Replace category headings that each contain only one destination with a simple direct navigation list. Use a 176-pixel sidebar with the existing product identity at the top and shortcut/version details at the bottom.

The content pane uses one alignment grid:

- page title and one-sentence description;
- named groups separated by whitespace and a single top rule;
- rows with label and supporting text on the left, control on the right;
- controls stack below labels at narrow widths.

Remove decorative radial backgrounds, gradient cards, inset highlights, and heavy shadows. Reserve contained panels for progress, errors, destructive confirmation, and other states that require grouping. Keep save feedback, retry handling, provider/key security behavior, model downloads, clipboard disclosure, update installation, and all current controls.

Buttons, inputs, selects, switches, badges, progress meters, focus rings, disabled states, and error states share a consistent height and radius. Destructive actions remain visually distinct and require the existing confirmation step.

## Voice selection and preview

Replace the voice select plus Preview plus Use Voice controls with a labeled voice-choice group. Show all six installed-engine voices as compact selectable options. Each option exposes its real voice name and selected state without inventing unsupported personality or language claims.

When a voice option is activated:

1. clear the previous preview error;
2. persist the chosen voice immediately when it differs from the saved value;
3. invoke `preview_voice` for that voice;
4. show a playing indicator only on the active option;
5. ignore completion events from older preview generations;
6. allow activating the selected option again to replay it.

Starting a new preview supersedes the previous one through the existing generation-based backend. If the engine is unavailable, the voice group stays disabled and explains how to install it. Preview failure remains inline and does not revert an already saved selection.

## Accessibility and interaction constraints

- Preserve semantic headings, labels, status regions, alerts, and skip navigation.
- Use native buttons, radio semantics, and form controls where applicable.
- Keep visible keyboard focus and logical tab order.
- Meet WCAG AA contrast for text and controls.
- Keep every action label on one line at the default desktop window size.
- Animate only opacity and transforms, except existing progress-meter fills.
- Preserve the global reduced-motion override.
- Do not add continuous animation or pointer tracking.

## Implementation boundaries

Expected production changes are limited to:

- `synapse/src-tauri/src/lib.rs`
- `synapse/src/Wheel.tsx`
- `synapse/src/App.css`
- `synapse/src/Onboarding.tsx`
- `synapse/src/Onboarding.css`
- `synapse/src/Settings.tsx`
- `synapse/src/Settings.css`
- `synapse/src/settings/VoiceSection.tsx`
- focused tests and repo guards needed to lock the new behavior

Avoid unrelated redesigns of Notes, Clipboard, AI Panel, or Sticky Notes. Shared token changes are allowed only when the affected value is safe for every consumer; otherwise keep the change local to the redesigned surfaces.

## Verification

- Unit-test wheel geometry at the smaller dimensions.
- Unit-test voice choice behavior, including immediate save, replay, stale completion events, disabled state, and preview errors.
- Run frontend tests, typecheck, lint, guards, guard self-tests, and Rust library tests.
- Build the frontend and let the running Tauri development process rebuild the Rust shell.
- Inspect wheel, onboarding, and every settings section at their default window sizes in one visual pass; fix the resulting issues in one batch and confirm once.
