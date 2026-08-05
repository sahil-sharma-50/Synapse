import { getCurrentWindow } from "@tauri-apps/api/window";
import Wheel from "./Wheel";
import NotesHub from "./NotesHub";
import StickyNote from "./StickyNote";
import Clipboard from "./Clipboard";
import AiPanel from "./AiPanel";
import Settings from "./Settings";
import Onboarding from "./Onboarding";

// Every window loads the same index.html, so routing keys off the window
// label set in src-tauri/src/lib.rs. (A URL hash was tried first — Tauri
// escapes the '#', so window.location.hash was always empty and each window
// fell through to the wheel.)
const NOTE_PREFIX = "note-";

export default function App() {
  const label = getCurrentWindow().label;

  // Sticky notes are created at runtime, one window per note, so their labels
  // carry the note id — the label is the only channel that survives, for the
  // same '#'-escaping reason above. Checked before the switch.
  // Careful: "notes-hub" does NOT match "note-" (it is "notes-"), but the two
  // are one character apart. Do not rename either without re-reading this.
  if (label.startsWith(NOTE_PREFIX)) {
    return <StickyNote id={label.slice(NOTE_PREFIX.length)} />;
  }

  switch (label) {
    case "notes-hub":
      return <NotesHub />;
    case "clipboard":
      return <Clipboard />;
    case "ai-panel":
      return <AiPanel />;
    case "settings":
      return <Settings />;
    case "onboarding":
      return <Onboarding />;
    default:
      return <Wheel />;
  }
}
