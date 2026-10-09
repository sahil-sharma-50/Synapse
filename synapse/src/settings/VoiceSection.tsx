import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatBytes, useModelDownload } from "../modelDownload";
import { useTtsSetup } from "../ttsSetup";
import { ASR_MODEL, TTS_ENGINE, TTS_VOICES, type Settings } from "../models";
import { MicIcon, SpeakerIcon, StopIcon, WaveIcon } from "./icons";
import { chooseAndPreviewVoice, isCurrentPreview } from "./voicePreview";

interface VoiceSectionProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
}

interface TtsGenerationError {
  generation: number;
  message: string;
}

export default function VoiceSection({ settings, onChange }: VoiceSectionProps) {
  const model = useModelDownload();
  const tts = useTtsSetup();
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const previewGeneration = useRef<number | null>(null);
  const previewRequest = useRef(0);
  const pendingPreviewErrors = useRef(new Map<number, string>());

  useEffect(() => {
    const listeners = [
      listen<number>("tts-ended", (event) => {
        if (isCurrentPreview(previewGeneration.current, event.payload)) {
          previewGeneration.current = null;
          setPreviewingVoice(null);
        }
      }),
      listen<TtsGenerationError>("tts-generation-error", (event) => {
        if (!isCurrentPreview(previewGeneration.current, event.payload.generation)) {
          pendingPreviewErrors.current.set(event.payload.generation, event.payload.message);
          return;
        }
        previewGeneration.current = null;
        setPreviewingVoice(null);
        setPreviewError(event.payload.message);
      }),
    ];
    return () => {
      listeners.forEach((listener) => listener.then((unlisten) => unlisten()));
    };
  }, []);

  async function selectVoice(voice: string) {
    const request = ++previewRequest.current;
    previewGeneration.current = null;
    setPreviewError("");
    setPreviewingVoice(voice);
    try {
      const generation = await chooseAndPreviewVoice({
        voice,
        settings,
        save: onChange,
        preview: (selected) => invoke<number>("preview_voice", { voice: selected }),
      });
      if (request !== previewRequest.current) return;
      const generationError = pendingPreviewErrors.current.get(generation);
      pendingPreviewErrors.current.clear();
      if (generationError) {
        setPreviewingVoice(null);
        setPreviewError(generationError);
      } else {
        previewGeneration.current = generation;
      }
    } catch (error) {
      if (request !== previewRequest.current) return;
      previewGeneration.current = null;
      pendingPreviewErrors.current.clear();
      setPreviewingVoice(null);
      setPreviewError(String(error));
    }
  }

  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">Voice</h2>
        <p className="set-subtitle">
          Speech recognition and spoken replies run locally. Messages sent to AI use your chosen
          provider.
        </p>
      </div>

      <h3 className="set-card-title">Speech-to-Text</h3>
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
              <button
                className={`set-btn ${model.ready ? "set-btn-quiet" : ""}`}
                onClick={model.start}
              >
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
                style={
                  model.known
                    ? ({ "--meter-progress": model.percent / 100 } as React.CSSProperties)
                    : undefined
                }
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
        {model.error && (
          <div className="set-card-row set-error" role="alert">
            {model.error}
          </div>
        )}

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
        <label className="set-card-row">
          <span className="set-label-stack">
            <span className="set-label">Pause before stopping</span>
            <span className="set-sublabel">Longer pauses give you more time to think</span>
          </span>
          <select
            className="set-input set-input-compact"
            value={settings.voice.silence_ms}
            disabled={!settings.voice.auto_stop_on_silence}
            onChange={(event) =>
              onChange({
                ...settings,
                voice: { ...settings.voice, silence_ms: Number(event.target.value) },
              })
            }
          >
            <option value={500}>0.5 seconds</option>
            <option value={900}>0.9 seconds (default)</option>
            <option value={1500}>1.5 seconds</option>
            <option value={2000}>2 seconds</option>
            <option value={3000}>3 seconds</option>
          </select>
        </label>
        <label className="set-card-row">
          <span className="set-label-stack">
            <span className="set-label">Speech detection</span>
            <span className="set-sublabel">
              Choose what counts as speech above background noise
            </span>
          </span>
          <select
            className="set-input set-input-compact"
            value={settings.voice.speech_threshold}
            onChange={(event) =>
              onChange({
                ...settings,
                voice: { ...settings.voice, speech_threshold: Number(event.target.value) },
              })
            }
          >
            <option value={0.005}>Sensitive · quiet voice</option>
            <option value={0.015}>Balanced (default)</option>
            <option value={0.03}>Less sensitive · noisy room</option>
            <option value={0.05}>Least sensitive</option>
          </select>
        </label>
      </div>
      <p className="set-hint">Required for dictation and for talking to the AI by voice.</p>

      <h3 className="set-card-title">Text-to-Speech</h3>
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
                style={
                  tts.known
                    ? ({ "--meter-progress": tts.percent / 100 } as React.CSSProperties)
                    : undefined
                }
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
        {tts.error && (
          <div className="set-card-row set-error" role="alert">
            {tts.error}
          </div>
        )}

        <div className="set-card-row set-voice-row">
          <span className="set-row-icon">
            <WaveIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">Voice</span>
            {!tts.ready && (
              <span className="set-sublabel">Install the engine above to choose a voice</span>
            )}
          </span>
          <div className="set-voice-grid" role="group" aria-label="Choose and preview a voice">
            {TTS_VOICES.map((voice) => (
              <button
                key={voice}
                type="button"
                className={`set-voice-option${previewingVoice === voice ? " set-voice-option-playing" : ""}`}
                aria-pressed={voice === settings.tts.voice}
                disabled={!tts.ready}
                onClick={() => selectVoice(voice)}
              >
                <span>{voice}</span>
                <span className="set-voice-state">
                  {previewingVoice === voice
                    ? "Playing…"
                    : voice === settings.tts.voice
                      ? "Selected"
                      : "Preview"}
                </span>
              </button>
            ))}
          </div>
        </div>
        {previewError && (
          <div className="set-card-row set-error" role="alert">
            {previewError}
          </div>
        )}
      </div>
      <p className="set-hint">
        Used by "Speak Selected Text" and by the AI when it answers out loud. Without it, Synapse
        falls back to your operating system's built-in voice.
      </p>
    </div>
  );
}
