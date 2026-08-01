import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import "./Onboarding.css";

type Step = "welcome" | "mic" | "model" | "done";
type MicState = "idle" | "checking" | "granted" | "denied";

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

export default function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const [micState, setMicState] = useState<MicState>("idle");
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [modelReady, setModelReady] = useState(false);
  const [finishError, setFinishError] = useState("");

  useEffect(() => {
    invoke<boolean>("model_status").then(setModelReady);
  }, []);

  useEffect(() => {
    const unlistenProgress = listen<DownloadProgress>("model-download-progress", (e) => {
      setProgress(e.payload);
    });
    const unlistenDone = listen("model-download-done", () => {
      setDownloading(false);
      setModelReady(true);
    });
    const unlistenError = listen<string>("model-download-error", (e) => {
      setDownloading(false);
      setDownloadError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  async function requestMic() {
    setMicState("checking");
    try {
      await invoke("check_mic_access");
      setMicState("granted");
    } catch {
      setMicState("denied");
    }
  }

  function openMicSettings() {
    openUrl("ms-settings:privacy-microphone");
  }

  function startDownload() {
    setDownloadError("");
    setDownloading(true);
    invoke("download_model").catch((e) => {
      setDownloading(false);
      setDownloadError(String(e));
    });
  }

  async function finish() {
    setFinishError("");
    try {
      const settings = await invoke<Settings>("get_settings");
      await invoke("update_settings", { settings: { ...settings, onboarding_complete: true } });
      getCurrentWindow().close();
    } catch (e) {
      console.error("[synapse] failed to finish onboarding:", e);
      setFinishError(String(e));
    }
  }

  return (
    <div className="ob-root">
      {step === "welcome" && (
        <div className="ob-step">
          <h1 className="ob-title">Welcome to Synapse</h1>
          <p className="ob-text">
            Dictation, AI chat, screenshots, snippets, and a notepad — all one hotkey away
            (Ctrl+Alt+Enter). Let's get you set up.
          </p>
          <button className="ob-btn" onClick={() => setStep("mic")}>
            Get Started
          </button>
        </div>
      )}

      {step === "mic" && (
        <div className="ob-step">
          <h1 className="ob-title">Microphone access</h1>
          <p className="ob-text">
            Speech-to-Text needs microphone access to transcribe what you say.
          </p>
          {micState === "granted" && (
            <div className="ob-status ob-ok">Microphone access confirmed.</div>
          )}
          {micState === "denied" && (
            <div className="ob-status ob-warn">
              <span>Windows is blocking microphone access for Synapse.</span>
              <button className="ob-btn ob-btn-quiet" onClick={openMicSettings}>
                Open Privacy Settings
              </button>
            </div>
          )}
          {micState !== "granted" && (
            <button className="ob-btn" onClick={requestMic} disabled={micState === "checking"}>
              {micState === "checking" ? "Checking…" : "Grant Access"}
            </button>
          )}
          <div className="ob-nav">
            <button className="ob-link" onClick={() => setStep("welcome")}>
              Back
            </button>
            <button className="ob-btn" onClick={() => setStep("model")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "model" && (
        <div className="ob-step">
          <h1 className="ob-title">Speech-to-Text model</h1>
          <p className="ob-text">
            Dictation runs fully offline using a local ~690MB model. Download it now, or skip and
            grab it later from Settings → Voice.
          </p>
          {modelReady && <div className="ob-status ob-ok">Model already downloaded.</div>}
          {!modelReady && downloading && progress && (
            <div className="ob-progress">
              <div className="ob-progress-bar">
                <div
                  className="ob-progress-fill"
                  style={{
                    width: `${(100 * progress.overall_bytes_downloaded) / Math.max(progress.overall_bytes_total, 1)}%`,
                  }}
                />
              </div>
              <p className="ob-small">
                {formatMb(progress.overall_bytes_downloaded)} MB / {formatMb(progress.overall_bytes_total)} MB
              </p>
            </div>
          )}
          {downloadError && (
            <div className="ob-status ob-warn">
              <span>{downloadError}</span>
              <button className="ob-btn ob-btn-quiet" onClick={startDownload}>
                Retry
              </button>
            </div>
          )}
          {!modelReady && !downloading && !downloadError && (
            <div className="ob-nav">
              <button className="ob-link" onClick={() => setStep("done")}>
                Skip for now
              </button>
              <button className="ob-btn" onClick={startDownload}>
                Download Now
              </button>
            </div>
          )}
          {modelReady && (
            <div className="ob-nav">
              <span />
              <button className="ob-btn" onClick={() => setStep("done")}>
                Continue
              </button>
            </div>
          )}
        </div>
      )}

      {step === "done" && (
        <div className="ob-step">
          <h1 className="ob-title">You're all set</h1>
          <p className="ob-text">
            Press Ctrl+Alt+Enter anytime to open the wheel, or Ctrl+Alt+D to start dictating
            directly.
          </p>
          {finishError && (
            <div className="ob-status ob-warn">
              <span>{finishError}</span>
            </div>
          )}
          <button className="ob-btn" onClick={finish}>
            Open Synapse
          </button>
        </div>
      )}
    </div>
  );
}
