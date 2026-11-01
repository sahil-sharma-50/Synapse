import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatBytes } from "../modelDownload";

/** Where this copy gets updates: the GitHub installer, or the Microsoft Store (MSIX). */
type UpdateChannel = "direct" | "store";

/** Synapse's Store listing (Partner Center product 9PDDK7S60F73). */
const STORE_LISTING_URL = "ms-windows-store://pdp/?productid=9PDDK7S60F73";

interface UpdateInfo {
  current_version: string;
  latest_version: string;
  available: boolean;
}

interface UpdateDownloadProgress {
  bytes_downloaded: number;
  bytes_total: number;
}

type Status = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing";

/**
 * Settings → Updates. The Rust side runs `tauri-plugin-updater`, which
 * verifies the installer's signature against the pinned public key before
 * running it — nothing here chooses or validates what gets installed, and no
 * URL crosses this boundary. Progress comes back over the `update-download-*`
 * events, same shape as `useModelDownload`.
 *
 * Download and install are a single backend call, so there is no separate
 * "install" step to drive: `update-download-done` means the bytes are in and
 * the install has begun, after which the app restarts itself.
 */
export default function UpdatesSection() {
  const [status, setStatus] = useState<Status>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState("");
  // Null until the backend answers, so neither variant flashes on open.
  const [channel, setChannel] = useState<UpdateChannel | null>(null);

  useEffect(() => {
    // Best-effort: shows the version immediately, but the check result also
    // carries it, so a failure here is not worth surfacing.
    getVersion()
      .then(setCurrentVersion)
      .catch(() => {});
    // A failed query falls back to "direct": the backend refuses the update
    // commands for a Store install anyway, so the worst case is an error message.
    invoke<UpdateChannel>("update_channel")
      .then(setChannel)
      .catch(() => setChannel("direct"));
  }, []);

  useEffect(() => {
    const unlistenProgress = listen<UpdateDownloadProgress>("update-download-progress", (e) =>
      setProgress(e.payload),
    );
    // The install starts as soon as the download lands, inside the same
    // backend call — this only moves the UI on.
    const unlistenDone = listen("update-download-done", () => setStatus("installing"));
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
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
      // Resolves, verifies and installs entirely in the backend. On success
      // this never returns — the app restarts into the new version.
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

  if (channel === "store") {
    return (
      <div className="set-section">
        <div className="set-page-head">
          <h2 className="set-title">Updates</h2>
          <p className="set-subtitle">
            This copy of Synapse was installed from the Microsoft Store, which installs updates
            automatically.
          </p>
        </div>

        <div className="set-card">
          <div className="set-card-row">
            <span className="set-label">Current version</span>
            <div className="set-key">
              <span className="set-badge set-ok">v{currentVersion || "…"}</span>
            </div>
          </div>
          <div className="set-card-row">
            <span className="set-label" />
            <div className="set-key">
              <button
                className="set-btn set-btn-quiet"
                onClick={() => openUrl(STORE_LISTING_URL).catch((e) => setError(String(e)))}
              >
                Open in Microsoft Store
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="set-error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">Updates</h2>
        <p className="set-subtitle">
          Keep Synapse up to date. You choose when to download and install a new version. Installing
          an update restarts the app.
        </p>
      </div>

      <div className="set-card">
        <div className="set-card-row">
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
          <div className="set-card-row">
            <span className="set-label" />
            <div className="set-key">
              <button className="set-btn set-btn-quiet" onClick={check} disabled={busy}>
                Check for updates
              </button>
              {status === "available" && info && (
                <button className="set-btn" onClick={downloadAndInstall} disabled={busy}>
                  Download &amp; Install v{info.latest_version}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {status === "checking" && <p className="set-note">Checking for updates…</p>}

      {status === "downloading" && (
        <div className="set-progress">
          {/* The fill child is required even in the indeterminate case — the
              sweep animation lives on `.set-meter-idle .set-meter-fill`, so an
              empty track renders as a frozen bar and reads as a hang. */}
          <div className={`set-meter ${known ? "" : "set-meter-idle"}`}>
            <div
              className="set-meter-fill"
              style={
                known ? ({ "--meter-progress": percent / 100 } as React.CSSProperties) : undefined
              }
            />
          </div>
          <div className="set-progress-foot">
            <span>{known ? `${Math.floor(percent)}%` : "Downloading…"}</span>
            <span>{known ? `${formatBytes(downloaded)} of ${formatBytes(total)}` : ""}</span>
          </div>
        </div>
      )}

      {status === "installing" && <p className="set-note">Installing… Synapse will restart.</p>}

      {error && (
        <div className="set-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
