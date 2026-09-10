import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "../models";
import { ClipboardIcon, TrashIcon } from "./icons";

interface ClipboardSectionProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

export default function ClipboardSection({ settings, onChange }: ClipboardSectionProps) {
  const [count, setCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function refresh() {
    invoke<{ pinned: boolean }[]>("list_clipboard")
      .then((entries) => {
        setCount(entries.filter((e) => !e.pinned).length);
        setLoadError(false);
      })
      .catch(() => {
        setCount(null);
        setLoadError(true);
      });
  }

  useEffect(refresh, []);

  useEffect(() => {
    const unlisten = listen("clipboard-changed", refresh);
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const enabled = settings.clipboard.history_enabled;

  function updateClipboard(patch: Partial<Settings["clipboard"]>) {
    onChange({ ...settings, clipboard: { ...settings.clipboard, ...patch } });
  }

  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">Clipboard</h2>
        <p className="set-subtitle">
          Everything you copy is kept here so you can paste it again later.
        </p>
      </div>

      <div className="set-card-title">History</div>
      <div className="set-card">
        <label className="set-card-row">
          <span className="set-row-icon">
            <ClipboardIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">Remember what I copy</span>
            <span className="set-sublabel">
              {loadError
                ? "Couldn't load history"
                : count === null
                  ? "Loading history..."
                : `${count} item${count === 1 ? "" : "s"} stored`}
            </span>
          </span>
          <div className="set-control">
            <input
              type="checkbox"
              className="set-switch"
              checked={enabled}
              onChange={(e) => updateClipboard({ history_enabled: e.target.checked })}
            />
          </div>
        </label>

        <div className="set-card-row">
          <span className="set-row-icon">
            <TrashIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">Clear history</span>
            <span className="set-sublabel">Pinned items are kept</span>
          </span>
          <div className="set-control">
            {confirming ? (
              <>
                <button
                  className="set-btn set-btn-danger"
                  onClick={() =>
                    invoke("clear_clipboard_history").then(() => {
                      setConfirming(false);
                      refresh();
                    })
                  }
                >
                  Delete everything
                </button>
                <button className="set-btn set-btn-quiet" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="set-btn set-btn-quiet"
                onClick={() => setConfirming(true)}
                disabled={!count}
              >
                Clear history
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="set-card-title">Capture</div>
      <div className="set-card set-grid-card">
        {([
          ["capture_text", "Text", "Plain and formatted text"],
          ["capture_links", "Links", "URLs with a readable domain"],
          ["capture_images", "Images", "Screenshots and copied images"],
          ["capture_files", "Files", "File names and original paths"],
        ] as const).map(([key, label, detail]) => (
          <label className="set-card-row" key={key}>
            <span className="set-label-stack">
              <span className="set-label">{label}</span>
              <span className="set-sublabel">{detail}</span>
            </span>
            <input
              type="checkbox"
              className="set-switch"
              checked={settings.clipboard[key]}
              disabled={!enabled}
              onChange={(event) => updateClipboard({ [key]: event.target.checked })}
            />
          </label>
        ))}
      </div>

      <div className="set-card-title">Retention</div>
      <div className="set-card">
        <label className="set-card-row">
          <span className="set-label-stack"><span className="set-label">Keep history for</span><span className="set-sublabel">Pinned items never expire</span></span>
          <select className="set-input set-input-compact" value={settings.clipboard.retention_days} onChange={(event) => updateClipboard({ retention_days: Number(event.target.value) })}>
            <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
          </select>
        </label>
        <label className="set-card-row">
          <span className="set-label-stack"><span className="set-label">Unpinned item limit</span><span className="set-sublabel">Oldest items leave first</span></span>
          <select className="set-input set-input-compact" value={settings.clipboard.max_unpinned_items} onChange={(event) => updateClipboard({ max_unpinned_items: Number(event.target.value) })}>
            <option value={100}>100</option><option value={250}>250</option><option value={500}>500</option><option value={1000}>1,000</option>
          </select>
        </label>
        <label className="set-card-row">
          <span className="set-label-stack"><span className="set-label">Storage limit</span><span className="set-sublabel">Images count toward this limit</span></span>
          <select className="set-input set-input-compact" value={settings.clipboard.max_storage_mb} onChange={(event) => updateClipboard({ max_storage_mb: Number(event.target.value) })}>
            <option value={50}>50 MB</option><option value={100}>100 MB</option><option value={250}>250 MB</option><option value={500}>500 MB</option>
          </select>
        </label>
      </div>

      {/* Said plainly rather than buried: this is a file on disk that will
          contain whatever passed through the clipboard, secrets included. */}
      <p className="set-hint">
        History is saved on this machine so it survives a restart. That means anything you copy —
        including passwords and one-time codes — is written to a file in Synapse's data folder.
        Turn the switch off to stop recording immediately; existing entries stay until you clear
        them.
      </p>
    </div>
  );
}
