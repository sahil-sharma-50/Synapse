import { formatBytes, useModelDownload } from "../modelDownload";

export default function VoiceSection() {
  const model = useModelDownload();

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
    </div>
  );
}
