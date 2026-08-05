import { Fragment, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import AiSection from "./settings/AiSection";
import VoiceSection from "./settings/VoiceSection";
import ClipboardSection from "./settings/ClipboardSection";
import UpdatesSection from "./settings/UpdatesSection";
import { ClipboardIcon, RefreshIcon, SparkleIcon, SpeakerIcon } from "./settings/icons";
import type { Settings as SettingsData } from "./models";
import "./Settings.css";

// Only sections that actually exist are listed. General, Microphone, Capture,
// Permissions and About get added as they're built — a sidebar full of
// "coming soon" rows is dead UI.
const SECTIONS = [
  { id: "ai", label: "AI", group: "AI & Agents", icon: SparkleIcon },
  { id: "voice", label: "Voice", group: "Voice", icon: SpeakerIcon },
  { id: "clipboard", label: "Clipboard", group: "Capture", icon: ClipboardIcon },
  { id: "updates", label: "Updates", group: "About", icon: RefreshIcon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [section, setSection] = useState<SectionId>("ai");
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    invoke<SettingsData>("get_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
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

  let lastGroup = "";

  return (
    <div className="set-root">
      <nav className="set-sidebar">
        {SECTIONS.map((s) => {
          const showGroupLabel = s.group !== lastGroup;
          lastGroup = s.group;
          // Fragment, not a wrapper div — nav buttons must stay direct children
          // of the flex column sidebar to stretch to its full width.
          return (
            <Fragment key={s.id}>
              {showGroupLabel && <div className="set-group-label">{s.group}</div>}
              <button
                className={`set-nav ${section === s.id ? "set-nav-active" : ""}`}
                onClick={() => setSection(s.id)}
                // The label span is display:none in the collapsed icon rail,
                // which also removes it from the accessibility tree — so the
                // button needs a name that survives.
                aria-label={s.label}
                aria-current={section === s.id ? "page" : undefined}
                title={s.label}
              >
                <span className="set-nav-icon">
                  <s.icon />
                </span>
                {/* Named so the narrow-window rule can hide the text and leave
                    an icon rail, rather than crushing the content pane. */}
                <span className="set-nav-label">{s.label}</span>
              </button>
            </Fragment>
          );
        })}
        {version && <div className="set-sidebar-foot">Version {version}</div>}
      </nav>
      <main className="set-main">
        {error && <div className="set-error">{error}</div>}
        {section === "ai" && <AiSection settings={settings} onChange={update} />}
        {section === "voice" && <VoiceSection settings={settings} onChange={update} />}
        {section === "clipboard" && <ClipboardSection settings={settings} onChange={update} />}
        {section === "updates" && <UpdatesSection />}
      </main>
    </div>
  );
}
