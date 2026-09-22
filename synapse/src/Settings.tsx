import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import logo from "./assets/synapse.png";
import type { Settings as SettingsData } from "./models";
import "./Settings.css";
import WindowChrome from "./WindowChrome";
import AiSection from "./settings/AiSection";
import AiHistory from "./settings/AiHistory";
import AiUsage from "./settings/AiUsage";
import ClipboardSection from "./settings/ClipboardSection";
import {
  ChatIcon,
  ClipboardIcon,
  ColorPickerIcon,
  LineChartIcon,
  RefreshIcon,
  SparkleIcon,
  SpeakerIcon,
} from "./settings/icons";
import UpdatesSection from "./settings/UpdatesSection";
import VoiceSection from "./settings/VoiceSection";
import GeneralSection from "./settings/GeneralSection";
import AppearanceSection from "./settings/AppearanceSection";
import { ControlsIcon } from "./settings/icons";
import { ShortcutKeys } from "./settings/ShortcutRecorder";

const SECTIONS = [
  { id: "general", label: "Controls", icon: ControlsIcon },
  { id: "appearance", label: "Wheel & color", icon: ColorPickerIcon },
  { id: "ai", label: "AI", icon: SparkleIcon },
  { id: "voice", label: "Voice", icon: SpeakerIcon },
  { id: "clipboard", label: "Clipboard", icon: ClipboardIcon },
  { id: "usage", label: "Usage", icon: LineChartIcon },
  { id: "history", label: "Conversations", icon: ChatIcon },
  { id: "updates", label: "Updates", icon: RefreshIcon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [section, setSection] = useState<SectionId>("general");
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
      .catch((cause) => setError(String(cause)));
  }, []);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("settings-navigate", (event) => {
      if (SECTIONS.some((item) => item.id === event.payload))
        setSection(event.payload as SectionId);
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  function update(next: SettingsData) {
    setSettings(next);
    setError("");
    setSaveStatus("Saving changes…");
    const current = ++revision.current;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await invoke("update_settings", { settings: next });
        if (current === revision.current) setSaveStatus("Changes saved");
      } catch (cause) {
        if (current === revision.current) {
          setSaveStatus("Changes not saved");
          setError(String(cause));
        }
      }
    });
  }

  if (!settings) {
    return (
      <div className="set-root set-loading" role="status">
        <img src={logo} width="48" height="48" alt="" />
        <h1 className="set-title">{error ? "Settings couldn't load" : "Loading settings…"}</h1>
        {error && (
          <>
            <p className="set-error" role="alert">
              {error}
            </p>
            <button className="set-btn" onClick={loadSettings}>
              Try again
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="set-root">
      <a className="set-skip-link" href="#settings-content">
        Skip to settings content
      </a>
      <WindowChrome
        title="Synapse Settings"
        subtitle={SECTIONS.find((item) => item.id === section)?.label}
      />
      <div className="set-workspace">
        <nav className="set-sidebar" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`set-nav ${section === item.id ? "set-nav-active" : ""}`}
              onClick={() => setSection(item.id)}
              aria-label={item.label}
              aria-current={section === item.id ? "page" : undefined}
              title={item.label}
            >
              <span className="set-nav-icon">
                <item.icon />
              </span>
              <span className="set-nav-label">{item.label}</span>
            </button>
          ))}
          <div className="set-sidebar-foot">
            <span>Open wheel</span>
            <ShortcutKeys value={settings.shortcuts.wheel} />
            {version && <span>Synapse {version}</span>}
          </div>
        </nav>
        <main className="set-main" id="settings-content" tabIndex={-1}>
          {section !== "history" && (
            <div className="set-save-status" role="status">
              {saveStatus ||
                (section === "general"
                  ? "Apply shortcut changes below"
                  : "Preferences save automatically")}
            </div>
          )}
          {error && (
            <div className="set-error" role="alert">
              <p>Couldn't save your changes. {error}</p>
              <button className="set-btn set-btn-quiet" onClick={() => update(settings)}>
                Retry save
              </button>
            </div>
          )}
          {section === "general" && <GeneralSection settings={settings} onChange={update} />}
          {section === "appearance" && <AppearanceSection settings={settings} onChange={update} />}
          {section === "ai" && <AiSection settings={settings} onChange={update} />}
          {section === "voice" && <VoiceSection settings={settings} onChange={update} />}
          {section === "clipboard" && <ClipboardSection settings={settings} onChange={update} />}
          {section === "history" && <AiHistory />}
          {section === "usage" && <AiUsage settings={settings} onChange={update} />}
          {section === "updates" && <UpdatesSection />}
        </main>
      </div>
    </div>
  );
}
