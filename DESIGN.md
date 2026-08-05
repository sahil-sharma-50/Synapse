# Design

The visual system for Synapse. `synapse/src/theme.css` is the implementation of
this document; where the two disagree, the CSS is right and this file is stale.

## The scene this is designed for

Synapse is summoned mid-task, on top of whatever the user was already doing, by
someone who wants to be back in their other app within seconds. Nothing here is
a destination. That single fact decides most of the design:

- **Dark, deliberately.** Not a category habit. The overlay is a transparent
  window composited over unknown desktop content and appears without warning; a
  light surface would flash as glare on every summon. The utility windows follow
  the overlay so the app reads as one product rather than an overlay plus a set
  of dialogs.
- **Operate, not Persuade.** Every surface except the orb is a task surface.
  Scanability, a single alignment axis, and native expectations outrank
  expression. Brand lives in the details — the icon rhythm, the focus ring, the
  meter — not in decoration.
- **Nothing pretends to be busy.** Progress meters animate only when something
  is genuinely happening, and levels come from real data (microphone RMS), never
  a loop that looks the same whether the feature works or not.

## Tokens

All of it lives in `theme.css` under a `--sy-` prefix. Window stylesheets
`@import "./theme.css"` and express themselves entirely in tokens. **A raw hex
value or a bare pixel gap in a window stylesheet is a bug** — the token is
missing; add it centrally.

| Group | Notes |
|---|---|
| Surfaces | `bg` → `sunken` → `panel` → `raised`, darkest to lightest. `float`/`scrim` for windows that sit over unknown content. |
| Ink | `text`, `text-dim`, `text-faint`. Dim and faint are alpha-based so they tint correctly on coloured surfaces (the sticky notes) instead of going gray. |
| Accent | Two values with different jobs: `accent` is light enough to be *text* on dark; `accent-solid` is saturated enough to carry dark text *on top of it*. Swapping their roles fails contrast. |
| Space | 2/4/6/8/12/16/20/28/40. Two half-steps at the small end because that's where control padding lives. |
| Type | Segoe UI Variable (the Windows 11 system face), Text and Display optical sizes. 10→26px. |
| Radius | 6/8/12/16/pill. Cards land at 12–16; pills are for small controls only. |
| Elevation | Three shadows, each with a real vertical offset and soft blur. |
| Motion | `fast`/`base`/`slow` + an exponential ease-out. |

## Rules that are easy to break

1. **Declare elevation once.** A border *or* a shadow, never both — a 1px border
   under a wide soft shadow is the ghost-card look. Settings cards use a border;
   floating windows use a shadow; list rows use a background shift.
2. **Indeterminate meters need a fill child.** Both meter styles animate through
   a *descendant* selector (`.set-meter-idle .set-meter-fill`). A childless track
   renders as a permanently frozen empty bar that users read as a hang.
3. **Animate from an already-visible default.** The wheel scales in from 0.94,
   not from nothing; the orb breathes around its resting size. Nothing pops.
4. **Note colours are shared state.** `noteColors.ts` must match `notes::COLORS`
   in Rust, which rejects any colour it doesn't recognise.
5. **Reduced motion is handled globally** in `theme.css`. Don't re-implement it
   per stylesheet.

## Per-surface intent

- **Wheel** (`App.css`) — transparent, over anything. The hub is both the
  dismiss target and the drag handle, hence `cursor: grab`. The listening state
  shows a real level meter and an elapsed timer, because dictation now runs
  until the user stops it and a static animation would be indistinguishable from
  a hang.
- **Settings** (`Settings.css`) — two panes, one trailing control axis so every
  row lines up regardless of label length. Collapses to an icon rail under
  620px. The most conventional surface in the app, on purpose.
- **Clipboard** (`Clipboard.css`) — the most keyboard-driven surface: type to
  filter, ↑/↓, Enter to paste. Dense rows, actions revealed only on the active
  row (a delete button on all 500 rows is an invitation to misclick).
- **Sticky notes** (`StickyNote.css`) — deep, desaturated colours rather than
  highlighter yellows, because these float over a dark desktop all day. Each
  note tints its own ink from its own hue.
- **AI orb** (`AiPanel.css`) — the one Experience surface. The orb *is* the
  interface: the only large element, the only thing that moves, and every
  conversation state is legible from it across the room. Colour carries state
  (blue idle/listening → violet thinking → amber speaking) so it never needs to
  be read. The transcript is deliberately quiet — no bubbles, no avatars, no
  timestamps — because it exists to be *checked*, not read. If the transcript
  ever starts competing for attention, this has drifted back into being a chat
  window with a logo on it.
