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
  const [confirming, setConfirming] = useState(false);

  function refresh() {
    invoke<{ pinned: boolean }[]>("list_clipboard")
      .then((entries) => setCount(entries.filter((e) => !e.pinned).length))
      .catch(() => setCount(null));
  }

  useEffect(refresh, []);

  useEffect(() => {
    const unlisten = listen("clipboard-changed", refresh);
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const enabled = settings.clipboard.history_enabled;

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
              {count === null
                ? "Off — nothing is being recorded"
                : `${count} item${count === 1 ? "" : "s"} stored`}
            </span>
          </span>
          <div className="set-control">
            <input
              type="checkbox"
              className="set-switch"
              checked={enabled}
              onChange={(e) =>
                onChange({
                  ...settings,
                  clipboard: { ...settings.clipboard, history_enabled: e.target.checked },
                })
              }
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
