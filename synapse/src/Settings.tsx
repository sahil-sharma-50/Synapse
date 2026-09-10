import { Fragment, useEffect, useRef, useState } from "react";
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
import logo from "./assets/synapse.png";
import WindowChrome from "./WindowChrome";

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
  const [saveStatus, setSaveStatus] = useState("");
  const saveQueue = useRef(Promise.resolve());
  const revision = useRef(0);

  function loadSettings() {
    setError("");
    invoke<SettingsData>("get_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }

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
    setError("");
    setSaveStatus("Saving changes…");
    const current = ++revision.current;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await invoke("update_settings", { settings: next });
        if (current === revision.current) setSaveStatus("Changes saved");
      } catch (e) {
        if (current === revision.current) {
          setSaveStatus("Changes not saved");
          setError(String(e));
        }
      }
    });
  }

  if (!settings) {
    return <div className="set-root set-loading" role="status">
      <img src={logo} width="48" height="48" alt="" />
      <h1 className="set-title">{error ? "Settings couldn't load" : "Loading settings…"}</h1>
      {error && <><p className="set-error" role="alert">{error}</p><button className="set-btn" onClick={loadSettings}>Try again</button></>}
    </div>;
  }

  return (
    <div className="set-root">
      <a className="set-skip-link" href="#settings-content">Skip to settings content</a>
      <WindowChrome title="Synapse Settings" subtitle={SECTIONS.find((item) => item.id === section)?.label} />
      <div className="set-workspace">
      <nav className="set-sidebar sy-glass" aria-label="Settings sections">
        <div className="set-brand"><span className="set-brand-mark" aria-hidden="true" /><span>Synapse<small>Settings</small></span></div>
        {SECTIONS.map((s, index) => {
          // Fragment, not a wrapper div — nav buttons must stay direct children
          // of the flex column sidebar to stretch to its full width.
          return (
            <Fragment key={s.id}>
              {(index === 0 || SECTIONS[index - 1].group !== s.group) && (
                <div className="set-group-label">{s.group}</div>
              )}
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
        <div className="set-sidebar-foot"><span>Always within reach</span><kbd>Ctrl + Alt + Enter</kbd>{version && <span>Synapse {version}</span>}</div>
      </nav>
      <main className="set-main" id="settings-content" tabIndex={-1}>
        <div className={`set-save-status${saveStatus ? " set-save-status-visible" : ""}`} role="status">
          {saveStatus}
        </div>
        {error && <div className="set-error" role="alert"><p>Couldn't save your changes. {error}</p><button className="set-btn set-btn-quiet" onClick={() => update(settings)}>Retry save</button></div>}
        {section === "ai" && <AiSection settings={settings} onChange={update} />}
        {section === "voice" && <VoiceSection settings={settings} onChange={update} />}
        {section === "clipboard" && <ClipboardSection settings={settings} onChange={update} />}
        {section === "updates" && <UpdatesSection />}
      </main>
      </div>
    </div>
  );
}
