import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatBytes } from "../modelDownload";

interface UpdateInfo {
  current_version: string;
  latest_version: string;
  available: boolean;
  download_url: string;
  file_size: number;
}

interface UpdateDownloadProgress {
  bytes_downloaded: number;
  bytes_total: number;
}

type Status = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing";

/**
 * Settings → Updates: checks GitHub for a newer release, downloads the new
 * installer, and hands off to the silent NSIS install (which restarts the
 * app). Progress comes back over the `update-download-*` events the Rust side
 * emits, same shape as `useModelDownload`.
 */
export default function UpdatesSection() {
  const [status, setStatus] = useState<Status>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // Best-effort: shows the version immediately, but the check result also
    // carries it, so a failure here is not worth surfacing.
    getVersion()
      .then(setCurrentVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlistenProgress = listen<UpdateDownloadProgress>("update-download-progress", (e) =>
      setProgress(e.payload),
    );
    // The user already consented by clicking "Download & Install", so once the
    // download finishes, install immediately — the app exits ~1.5s later.
    const unlistenDone = listen("update-download-done", async () => {
      setStatus("installing");
      try {
        await invoke("install_update");
      } catch (e) {
        setStatus("available");
        setError(String(e));
      }
    });
    const unlistenError = listen<string>("update-download-error", (e) => {
      setStatus("available");
      setError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  async function check() {
    setError("");
    setStatus("checking");
    try {
      const result = await invoke<UpdateInfo>("check_for_update");
      setInfo(result);
      setStatus(result.available ? "available" : "up-to-date");
    } catch (e) {
      setStatus("idle");
      setError(String(e));
    }
  }

  async function downloadAndInstall() {
    if (!info) return;
    setError("");
    setProgress(null);
    setStatus("downloading");
    try {
      // No URL argument on purpose — the backend resolves the release itself
      // rather than executing whatever this window asks it to download.
      await invoke("download_update");
    } catch (e) {
      setStatus("available");
      setError(String(e));
    }
  }

  const busy = status === "checking" || status === "downloading" || status === "installing";
  const total = progress?.bytes_total ?? 0;
  const downloaded = progress?.bytes_downloaded ?? 0;
  const known = total > 0;
  const percent = known ? Math.min(100, (100 * downloaded) / total) : 0;

  return (
    <div className="set-section">
      <h2 className="set-title">Updates</h2>

      <p className="set-hint">
        Synapse checks GitHub for new releases. When a newer version is published, you can download
        and install it right here — no need to grab the installer from the browser.
      </p>

      <div className="set-row">
        <span className="set-label">Current version</span>
        <div className="set-key">
          <span className="set-badge set-ok">v{currentVersion || "…"}</span>
          {status === "up-to-date" && <span className="set-note">You're up to date</span>}
          {status === "available" && info && (
            <span className="set-note">Update available: v{info.latest_version}</span>
          )}
        </div>
      </div>

      {(status === "idle" || status === "up-to-date" || status === "available") && (
        <div className="set-row">
          <span className="set-label" />
          <div className="set-key">
            <button className="set-btn set-btn-quiet" onClick={check} disabled={busy}>
              Check for updates
            </button>
            {status === "available" && info && (
              <button className="set-btn" onClick={downloadAndInstall} disabled={busy}>
                Download &amp; Install ({formatBytes(info.file_size)})
              </button>
            )}
          </div>
        </div>
      )}

      {status === "checking" && <p className="set-note">Checking for updates…</p>}

      {status === "downloading" && (
        <div className="set-progress">
          {/* The fill child is required even in the indeterminate case — the
              sweep animation lives on `.set-meter-idle .set-meter-fill`, so an
              empty track renders as a frozen bar and reads as a hang. */}
          <div className={`set-meter ${known ? "" : "set-meter-idle"}`}>
            <div className="set-meter-fill" style={known ? { width: `${percent}%` } : undefined} />
          </div>
          <div className="set-progress-foot">
            <span>{known ? `${Math.floor(percent)}%` : "Downloading…"}</span>
            <span>{known ? `${formatBytes(downloaded)} of ${formatBytes(total)}` : ""}</span>
          </div>
        </div>
      )}

      {status === "installing" && <p className="set-note">Installing… Synapse will restart.</p>}

      {error && <div className="set-error">{error}</div>}
    </div>
  );
}
