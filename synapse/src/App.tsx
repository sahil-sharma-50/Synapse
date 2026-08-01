import { getCurrentWindow } from "@tauri-apps/api/window";
import Wheel from "./Wheel";
import Notepad from "./Notepad";
import SnippetPicker from "./SnippetPicker";
import AiPanel from "./AiPanel";
import Settings from "./Settings";
import Onboarding from "./Onboarding";

// Every window loads the same index.html, so routing keys off the window
// label set in src-tauri/src/lib.rs. (A URL hash was tried first — Tauri
// escapes the '#', so window.location.hash was always empty and each window
// fell through to the wheel.)
export default function App() {
  const label = getCurrentWindow().label;

  switch (label) {
    case "notepad":
      return <Notepad />;
    case "snippet-picker":
      return <SnippetPicker />;
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
