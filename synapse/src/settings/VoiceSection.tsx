import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface DownloadProgress {
  file: string;
  file_bytes_downloaded: number;
  file_bytes_total: number;
  overall_bytes_downloaded: number;
  overall_bytes_total: number;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

export default function VoiceSection() {
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");

  function refresh() {
    invoke<boolean>("model_status").then(setReady);
  }

  useEffect(refresh, []);

  useEffect(() => {
    const unlistenProgress = listen<DownloadProgress>("model-download-progress", (e) =>
      setProgress(e.payload),
    );
    const unlistenDone = listen("model-download-done", () => {
      setDownloading(false);
      setReady(true);
    });
    const unlistenError = listen<string>("model-download-error", (e) => {
      setDownloading(false);
      setError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  function download() {
    setError("");
    setDownloading(true);
    invoke("download_model").catch((e) => {
      setDownloading(false);
      setError(String(e));
    });
  }

  return (
    <div className="set-section">
      <h2 className="set-title">Voice</h2>

      <div className="set-row">
        <span className="set-label">Model</span>
        <div className="set-key">
          <span className={`set-badge ${ready ? "set-ok" : "set-missing"}`}>
            {ready ? "Downloaded" : "Not downloaded"}
          </span>
          {!downloading && (
            <button className="set-btn" onClick={download}>
              {ready ? "Re-download" : "Download (690MB)"}
            </button>
          )}
        </div>
      </div>

      {downloading && progress && (
        <p className="set-hint">
          Downloading {progress.file}: {formatMb(progress.overall_bytes_downloaded)} MB /{" "}
          {formatMb(progress.overall_bytes_total)} MB
        </p>
      )}
      {error && <div className="set-error">{error}</div>}

      <p className="set-hint">
        Speech-to-Text runs fully offline using this local model — required for dictation.
      </p>
    </div>
  );
}
