import { formatBytes, useModelDownload } from "../modelDownload";
import { useTtsSetup } from "../ttsSetup";
import { TTS_VOICES, type Settings } from "../models";

interface VoiceSectionProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

export default function VoiceSection({ settings, onChange }: VoiceSectionProps) {
  const model = useModelDownload();
  const tts = useTtsSetup();

  return (
    <div className="set-section">
      <h2 className="set-title">Voice</h2>

      <div className="set-row">
        <span className="set-label">Model</span>
        <div className="set-key">
          <span className={`set-badge ${model.ready ? "set-ok" : "set-missing"}`}>
            {model.ready ? "Downloaded" : "Not downloaded"}
          </span>
          {!model.downloading && (
            <button className="set-btn" onClick={model.start}>
              {model.ready ? "Re-download" : "Download (~630 MB)"}
            </button>
          )}
        </div>
      </div>

      {model.downloading && (
        <div className="set-progress">
          <div className={`set-meter ${model.known ? "" : "set-meter-idle"}`}>
            <div
              className="set-meter-fill"
              style={model.known ? { width: `${model.percent}%` } : undefined}
            />
          </div>
          <div className="set-progress-foot">
            <span>
              {model.known ? `${Math.floor(model.percent)}% · ` : ""}
              {formatBytes(model.downloaded)}
              {model.known ? ` of ${formatBytes(model.total)}` : ""}
            </span>
            <span>{model.remaining}</span>
          </div>
        </div>
      )}
      {model.error && <div className="set-error">{model.error}</div>}

      <p className="set-hint">
        Speech-to-Text runs fully offline using this local model, required for dictation.
      </p>

      <div className="set-row">
        <span className="set-label">Text-to-Speech engine</span>
        <div className="set-key">
          <span className={`set-badge ${tts.ready ? "set-ok" : "set-missing"}`}>
            {tts.ready ? "Downloaded" : "Not downloaded"}
          </span>
          {!tts.downloading && (
            <button className="set-btn" onClick={tts.start}>
              {tts.ready ? "Re-download" : "Download (~1-2 GB)"}
            </button>
          )}
        </div>
      </div>

      {tts.downloading && (
        <div className="set-progress">
          <div className="set-meter set-meter-idle" />
          <div className="set-progress-foot">
            <span>{tts.stageLabel || "Starting…"}</span>
          </div>
        </div>
      )}
      {tts.error && <div className="set-error">{tts.error}</div>}

      <div className="set-row">
        <span className="set-label">Voice</span>
        <select
          className="set-select"
          disabled={!tts.ready}
          value={settings.tts.voice}
          onChange={(e) => onChange({ ...settings, tts: { ...settings.tts, voice: e.target.value } })}
        >
          {TTS_VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <p className="set-hint">
        "Speak Selected Text" and reading AI responses aloud both use this voice once downloaded,
        falling back to your OS's built-in voice otherwise.
      </p>
    </div>
  );
}
