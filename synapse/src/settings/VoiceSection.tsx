import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatBytes, useModelDownload } from "../modelDownload";
import { useTtsSetup } from "../ttsSetup";
import { ASR_MODEL, TTS_ENGINE, TTS_VOICES, type Settings } from "../models";
import { MicIcon, SpeakerIcon, StopIcon, WaveIcon } from "./icons";

interface VoiceSectionProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

export default function VoiceSection({ settings, onChange }: VoiceSectionProps) {
  const model = useModelDownload();
  const tts = useTtsSetup();
  const [voiceChoice, setVoiceChoice] = useState(settings.tts.voice);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewGeneration = useRef<number | null>(null);

  useEffect(() => {
    const listeners = [
      listen<number>("tts-ended", (event) => {
        if (event.payload === previewGeneration.current) {
          previewGeneration.current = null;
          setPreviewing(false);
        }
      }),
      listen<string>("tts-error", (event) => {
        setPreviewing(false);
        setPreviewError(event.payload);
      }),
    ];
    return () => {
      listeners.forEach((listener) => listener.then((unlisten) => unlisten()));
    };
  }, []);

  function previewVoice() {
    setPreviewError("");
    setPreviewing(true);
    invoke<number>("preview_voice", { voice: voiceChoice })
      .then((generation) => {
        previewGeneration.current = generation;
      })
      .catch((error) => {
        previewGeneration.current = null;
        setPreviewing(false);
        setPreviewError(String(error));
      });
  }

  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">Voice</h2>
        <p className="set-subtitle">
          Dictation and spoken replies both run on your machine. Nothing you say leaves it.
        </p>
      </div>

      <div className="set-card-title">Speech-to-Text</div>
      <div className="set-card">
        <div className="set-card-row">
          <span className="set-row-icon">
            <MicIcon />
          </span>
          {/* The row used to read just "Model", which told nobody what was on
              their disk. Name it. */}
          <span className="set-label-stack">
            <span className="set-label">{ASR_MODEL.name}</span>
            <span className="set-sublabel">{ASR_MODEL.detail}</span>
          </span>
          <div className="set-key">
            <span className={`set-badge ${model.ready ? "set-ok" : "set-missing"}`}>
              {model.ready ? "Installed" : "Not installed"}
            </span>
            {!model.downloading && (
              <button className={`set-btn ${model.ready ? "set-btn-quiet" : ""}`} onClick={model.start}>
                {model.ready ? "Re-download" : `Download (${ASR_MODEL.sizeLabel})`}
              </button>
            )}
          </div>
        </div>

        {model.downloading && (
          <div className="set-card-row set-progress">
            <div className={`set-meter ${model.known ? "" : "set-meter-idle"}`}>
              <div
                className="set-meter-fill"
                style={model.known ? { "--meter-progress": model.percent / 100 } as React.CSSProperties : undefined}
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
        {model.error && <div className="set-card-row set-error" role="alert">{model.error}</div>}

        <label className="set-card-row">
          <span className="set-row-icon">
            <StopIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">Stop automatically after silence</span>
            <span className="set-sublabel">
              Off: dictation runs until you press Enter or click the circle
            </span>
          </span>
          <div className="set-control">
            <input
              type="checkbox"
              className="set-switch"
              checked={settings.voice.auto_stop_on_silence}
              onChange={(e) =>
                onChange({
                  ...settings,
                  voice: { ...settings.voice, auto_stop_on_silence: e.target.checked },
                })
              }
            />
          </div>
        </label>
      </div>
      <p className="set-hint">
        Required for dictation and for talking to the AI by voice.
      </p>

      <div className="set-card-title">Text-to-Speech</div>
      <div className="set-card">
        <div className="set-card-row">
          <span className="set-row-icon">
            <SpeakerIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">
              {TTS_ENGINE.name} {TTS_ENGINE.version}
            </span>
            <span className="set-sublabel">{TTS_ENGINE.detail}</span>
          </span>
          <div className="set-key">
            <span className={`set-badge ${tts.ready ? "set-ok" : "set-missing"}`}>
              {tts.ready ? "Installed" : "Not installed"}
            </span>
            {!tts.downloading && (
              <button className={`set-btn ${tts.ready ? "set-btn-quiet" : ""}`} onClick={tts.start}>
                {tts.ready ? "Re-download" : `Download (${TTS_ENGINE.sizeLabel})`}
              </button>
            )}
          </div>
        </div>

        {tts.downloading && (
          // The fill child is required even in the indeterminate case — the
          // sweep animation lives on `.set-meter-idle .set-meter-fill`, so
          // an empty track renders as a frozen bar and reads as a hang.
          <div className="set-card-row set-progress">
            <div className={`set-meter ${tts.known ? "" : "set-meter-idle"}`}>
              <div
                className="set-meter-fill"
                style={tts.known ? { "--meter-progress": tts.percent / 100 } as React.CSSProperties : undefined}
              />
            </div>
            <div className="set-progress-foot">
              <span>{tts.stageLabel || "Starting…"}</span>
              <span>
                {tts.known ? `${formatBytes(tts.downloaded)} of ${formatBytes(tts.total)}` : ""}
              </span>
            </div>
          </div>
        )}
        {tts.error && <div className="set-card-row set-error" role="alert">{tts.error}</div>}

        <label className="set-card-row">
          <span className="set-row-icon">
            <WaveIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">Voice</span>
            {!tts.ready && (
              <span className="set-sublabel">Install the engine above to choose a voice</span>
            )}
          </span>
          <div className="set-control set-voice-control">
            <select
              className="set-input"
              disabled={!tts.ready}
              value={voiceChoice}
              onChange={(e) => setVoiceChoice(e.target.value)}
            >
              {TTS_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button className="set-btn set-btn-quiet" disabled={!tts.ready || previewing} onClick={previewVoice}>
              {previewing ? "Playing…" : "Preview"}
            </button>
            <button
              className="set-btn"
              disabled={!tts.ready || voiceChoice === settings.tts.voice}
              onClick={() => onChange({ ...settings, tts: { ...settings.tts, voice: voiceChoice } })}
            >
              Use voice
            </button>
          </div>
        </label>
        {previewError && <div className="set-card-row set-error" role="alert">{previewError}</div>}
      </div>
      <p className="set-hint">
        Used by "Speak Selected Text" and by the AI when it answers out loud. Without it, Synapse
        falls back to your operating system's built-in voice.
      </p>
    </div>
  );
}
