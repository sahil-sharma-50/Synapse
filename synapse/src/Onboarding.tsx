import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import { formatBytes, useModelDownload } from "./modelDownload";
import logo from "./assets/synapse.png";
import "./Onboarding.css";

const STEPS = ["welcome", "mic", "model", "done"] as const;
type Step = (typeof STEPS)[number];
type MicState = "idle" | "checking" | "granted" | "denied";

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  mic: "Microphone",
  model: "Model",
  done: "Finish",
};

const FEATURES = [
  { icon: "🎙", title: "Dictate anywhere", body: "Speak and the text lands in whatever you're typing in." },
  { icon: "✨", title: "Ask AI in place", body: "Send a prompt or a screenshot and insert the answer." },
  { icon: "📝", title: "Notes & snippets", body: "A scratchpad and reusable text, one hotkey away." },
];

export default function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const [micState, setMicState] = useState<MicState>("idle");
  const [finishError, setFinishError] = useState("");
  const model = useModelDownload();

  const stepIndex = STEPS.indexOf(step);

  async function requestMic() {
    setMicState("checking");
    try {
      await invoke("check_mic_access");
      setMicState("granted");
    } catch {
      setMicState("denied");
    }
  }

  async function finish() {
    setFinishError("");
    try {
      const settings = await invoke<Settings>("get_settings");
      await invoke("update_settings", { settings: { ...settings, onboarding_complete: true } });
      // Awaited so a failure to close surfaces in the UI instead of becoming a
      // silent unhandled rejection — a dead "Finish" button with no feedback
      // is exactly what this screen used to do.
      await getCurrentWindow().close();
    } catch (e) {
      console.error("[synapse] failed to finish onboarding:", e);
      setFinishError(String(e));
    }
  }

  return (
    <div className="ob-root">
      <header className="ob-head">
        <span className="ob-brand">Synapse</span>
        <ol className="ob-steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={`ob-dot ${i < stepIndex ? "ob-dot-done" : ""} ${i === stepIndex ? "ob-dot-now" : ""}`}
              title={STEP_LABELS[s]}
            />
          ))}
        </ol>
      </header>

      <main className="ob-body" key={step}>
        {step === "welcome" && (
          <div className="ob-step">
            <div className="ob-hero">
              <img className="ob-hero-mark" src={logo} alt="" />
            </div>
            <h1 className="ob-title">Welcome to Synapse</h1>
            <p className="ob-text">
              Everything sits behind one shortcut: press <kbd className="ob-kbd">Ctrl</kbd>
              <kbd className="ob-kbd">Alt</kbd>
              <kbd className="ob-kbd">Enter</kbd> to open the wheel.
            </p>
            <ul className="ob-features">
              {FEATURES.map((f) => (
                <li className="ob-feature" key={f.title}>
                  <span className="ob-feature-icon" aria-hidden="true">
                    {f.icon}
                  </span>
                  <div>
                    <p className="ob-feature-title">{f.title}</p>
                    <p className="ob-feature-body">{f.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === "mic" && (
          <div className="ob-step">
            <h1 className="ob-title">Microphone access</h1>
            <p className="ob-text">
              Dictation transcribes on this machine, audio never leaves your computer. Windows
              still needs your permission before Synapse can listen.
            </p>

            <div className={`ob-card ${micState === "granted" ? "ob-card-ok" : ""}`}>
              <div className="ob-card-row">
                <span className={`ob-pill ${micState === "granted" ? "ob-pill-ok" : micState === "denied" ? "ob-pill-warn" : ""}`}>
                  {micState === "granted"
                    ? "Allowed"
                    : micState === "denied"
                      ? "Blocked"
                      : "Not checked yet"}
                </span>
                {micState !== "granted" && (
                  <button
                    className="ob-btn ob-btn-sm"
                    onClick={requestMic}
                    disabled={micState === "checking"}
                  >
                    {micState === "checking" ? "Checking…" : "Allow microphone"}
                  </button>
                )}
              </div>
              <p className="ob-card-note">
                {micState === "granted"
                  ? "Synapse can record audio for transcription."
                  : micState === "denied"
                    ? "Windows is blocking microphone access. Turn Synapse on under Privacy & security → Microphone, then check again."
                    : "Clicking this opens Windows' own microphone prompt. You can also skip and do it later."}
              </p>
              {micState === "denied" && (
                <button className="ob-btn ob-btn-quiet ob-btn-sm" onClick={() => openUrl("ms-settings:privacy-microphone")}>
                  Open Windows privacy settings
                </button>
              )}
            </div>
          </div>
        )}

        {step === "model" && (
          <div className="ob-step">
            <h1 className="ob-title">Speech-to-Text model</h1>
            <p className="ob-text">
              Dictation runs fully offline using a local model. It's a one-time{" "}
              {model.known ? formatBytes(model.total) : "~630 MB"} download; interrupted downloads
              resume where they left off.
            </p>

            <div className={`ob-card ${model.ready ? "ob-card-ok" : ""}`}>
              {model.ready ? (
                <>
                  <div className="ob-card-row">
                    <span className="ob-pill ob-pill-ok">Installed</span>
                  </div>
                  <p className="ob-card-note">The model is on disk, dictation is ready to use.</p>
                </>
              ) : model.downloading ? (
                <>
                  <div className="ob-meter-head">
                    <span className="ob-meter-pct">
                      {model.known ? `${Math.floor(model.percent)}%` : "Starting…"}
                    </span>
                    <span className="ob-meter-eta">{model.remaining}</span>
                  </div>
                  <div className={`ob-meter ${model.known ? "" : "ob-meter-idle"}`}>
                    <div
                      className="ob-meter-fill"
                      style={model.known ? { width: `${model.percent}%` } : undefined}
                    />
                  </div>
                  <div className="ob-meter-foot">
                    <span>
                      {formatBytes(model.downloaded)}
                      {model.known ? ` of ${formatBytes(model.total)}` : ""}
                    </span>
                    <span>{model.rate > 0 ? `${formatBytes(model.rate)}/s` : ""}</span>
                  </div>
                  {model.progress && (
                    <p className="ob-card-note ob-truncate">Fetching {model.progress.file}</p>
                  )}
                </>
              ) : (
                <>
                  <div className="ob-card-row">
                    <span className="ob-pill">Not downloaded</span>
                    <button className="ob-btn ob-btn-sm" onClick={model.start}>
                      {model.error ? "Try again" : "Download now"}
                    </button>
                  </div>
                  <p className="ob-card-note">
                    {model.error || "You can skip this and grab it later from Settings → Voice."}
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="ob-step">
            <div className="ob-hero">
              <img className="ob-hero-mark" src={logo} alt="" />
            </div>
            <h1 className="ob-title">You're all set</h1>
            <p className="ob-text">
              Synapse keeps running in the background. Nothing stays on screen until you call it.
            </p>
            <ul className="ob-keys">
              <li>
                <span>
                  <kbd className="ob-kbd">Ctrl</kbd>
                  <kbd className="ob-kbd">Alt</kbd>
                  <kbd className="ob-kbd">Enter</kbd>
                </span>
                Open the wheel
              </li>
              <li>
                <span>
                  <kbd className="ob-kbd">Ctrl</kbd>
                  <kbd className="ob-kbd">Alt</kbd>
                  <kbd className="ob-kbd">D</kbd>
                </span>
                Start dictating right away
              </li>
            </ul>
            {finishError && <div className="ob-error">{finishError}</div>}
          </div>
        )}
      </main>

      <footer className="ob-foot">
        {stepIndex > 0 ? (
          <button className="ob-link" onClick={() => setStep(STEPS[stepIndex - 1])}>
            Back
          </button>
        ) : (
          <span />
        )}

        {step === "done" ? (
          <button className="ob-btn" onClick={finish}>
            Finish
          </button>
        ) : (
          <button className="ob-btn" onClick={() => setStep(STEPS[stepIndex + 1])}>
            {/* Moving on mid-download is allowed on purpose: the transfer runs on
                a background thread in Rust and survives this window closing, so
                blocking the wizard on it would only trap the user. */}
            {step === "welcome"
              ? "Get started"
              : step === "model" && !model.ready && !model.downloading
                ? "Skip for now"
                : "Continue"}
          </button>
        )}
      </footer>
    </div>
  );
}
