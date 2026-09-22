import { useState } from "react";
import type { Settings } from "../models";
import { WEDGES } from "../wedges";
import ShortcutRecorder, { ShortcutKeys } from "./ShortcutRecorder";

export default function GeneralSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings.shortcuts);
  const bindings = [draft.wheel, draft.dictation, ...Object.values(draft.tools)].filter(Boolean);
  const duplicate = new Set(bindings.map((value) => value.toLowerCase())).size !== bindings.length;
  const changed = JSON.stringify(draft) !== JSON.stringify(settings.shortcuts);
  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">Controls</h2>
        <p className="set-subtitle">Click a shortcut, then press the keys you want to use.</p>
      </div>
      <h3 className="set-card-title">Global shortcuts</h3>
      <div className="set-card">
        <div className="set-card-row">
          <span className="set-label-stack">
            <span className="set-label">Open wheel</span>
            <span className="set-sublabel">Your tools, wherever you are</span>
          </span>
          <div className="set-control">
            <ShortcutRecorder
              label="Open wheel"
              value={draft.wheel}
              onChange={(wheel) => setDraft({ ...draft, wheel })}
            />
          </div>
        </div>
        <div className="set-card-row">
          <span className="set-label-stack">
            <span className="set-label">Start dictation</span>
            <span className="set-sublabel">Speak into your focused app</span>
          </span>
          <div className="set-control">
            <ShortcutRecorder
              label="Start dictation"
              value={draft.dictation}
              onChange={(dictation) => setDraft({ ...draft, dictation })}
            />
          </div>
        </div>
      </div>
      <h3 className="set-card-title">Tool shortcuts</h3>
      <p className="set-hint">Optional shortcuts work even when a tool is hidden from the wheel.</p>
      <div className="set-card">
        {WEDGES.filter((tool) => tool.id !== "stt").map((tool) => (
          <div className="set-card-row" key={tool.id}>
            <span className="set-label">{tool.label}</span>
            <div className="set-control">
              <ShortcutRecorder
                label={tool.label}
                value={draft.tools[tool.id] || ""}
                optional
                onChange={(value) =>
                  setDraft({ ...draft, tools: { ...draft.tools, [tool.id]: value } })
                }
              />
            </div>
          </div>
        ))}
      </div>
      <p className="set-hint">
        Include Ctrl, Alt or Win. Escape cancels recording. Shortcuts take effect when you apply
        them.
      </p>
      {duplicate && (
        <p className="set-error" role="alert">
          Each tool needs a different shortcut.
        </p>
      )}
      <div className="set-actions set-actions-sticky">
        <button
          className="set-btn set-btn-quiet"
          onClick={() =>
            setDraft({ wheel: "Control+Alt+Enter", dictation: "Control+Alt+D", tools: {} })
          }
        >
          Use defaults
        </button>
        <button
          className="set-btn"
          disabled={!changed || duplicate}
          onClick={() => onChange({ ...settings, shortcuts: draft })}
        >
          Apply shortcuts
        </button>
      </div>
      <p className="set-hint set-shortcut-help">
        <ShortcutKeys value="Enter" /> finishes dictation. <ShortcutKeys value="Escape" /> stops
        speech or dismisses the wheel.
      </p>
    </div>
  );
}
