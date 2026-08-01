import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import AiSection from "./settings/AiSection";
import VoiceSection from "./settings/VoiceSection";
import type { Settings as SettingsData } from "./models";
import "./Settings.css";

// Only sections that actually exist are listed. Sub-project B adds General,
// Microphone, Capture, Snippets, Voice, Permissions and About as they're built —
// a sidebar full of "coming soon" rows is dead UI.
const SECTIONS = [
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [section, setSection] = useState<SectionId>("ai");
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<SettingsData>("get_settings").then(setSettings).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("settings-navigate", (e) => {
      if (SECTIONS.some((s) => s.id === e.payload)) {
        setSection(e.payload as SectionId);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Optimistic: render the change immediately, persist behind it. A failed
  // write surfaces as an error rather than a silently reverted control.
  function update(next: SettingsData) {
    setSettings(next);
    invoke("update_settings", { settings: next }).catch((e) => setError(String(e)));
  }

  if (!settings) {
    return <div className="set-root set-loading">Loading…</div>;
  }

  return (
    <div className="set-root">
      <nav className="set-sidebar">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`set-nav ${section === s.id ? "set-nav-active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="set-main">
        {error && <div className="set-error">{error}</div>}
        {section === "ai" && <AiSection settings={settings} onChange={update} />}
        {section === "voice" && <VoiceSection settings={settings} onChange={update} />}
      </main>
    </div>
  );
}
