import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PROVIDER_LABELS, modelFor, type Provider, type Settings } from "./models";
import "./AiPanel.css";

export default function AiPanel() {
  // Config is owned by the Settings window now; this panel just reads it.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [error, setError] = useState("");
  const responseRef = useRef("");
  const speakRepliesRef = useRef(speakReplies);
  speakRepliesRef.current = speakReplies;

  function refresh() {
    invoke<Settings>("get_settings").then((s) => {
      setSettings(s);
      invoke<Record<Provider, boolean>>("provider_status").then((status) =>
        setHasKey(status[s.ai.provider]),
      );
    });
  }

  useEffect(refresh, []);

  // The panel is hidden rather than closed, so an open window would otherwise
  // keep showing stale config after Settings changed it.
  useEffect(() => {
    const unlisten = listen<Settings>("settings-changed", () => refresh());
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlistenDelta = listen<string>("ai-delta", (e) => {
      responseRef.current += e.payload;
      setResponse(responseRef.current);
    });
    const unlistenDone = listen<string>("ai-done", (e) => {
      setStreaming(false);
      if (speakRepliesRef.current && e.payload.trim()) {
        invoke("speak_text", { text: e.payload });
      }
    });
    const unlistenError = listen<string>("ai-error", (e) => {
      setError(e.payload);
      setStreaming(false);
    });
    return () => {
      unlistenDelta.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  function send(overridePrompt?: string) {
    const text = (overridePrompt ?? prompt).trim();
    if (!text || streaming) return;
    responseRef.current = "";
    setResponse("");
    setError("");
    setStreaming(true);
    invoke("send_ai_message", { prompt: text });
  }

  async function recordAndSend() {
    if (recording || streaming) return;
    setRecording(true);
    setError("");
    try {
      const transcript = await invoke<string>("transcribe_for_ai");
      if (transcript.trim()) {
        setPrompt(transcript);
        send(transcript);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRecording(false);
    }
  }

  function insert() {
    if (!response) return;
    invoke("insert_ai_response", { content: response });
  }

  return (
    <div className="ai-root">
      <div className="ai-provider-row">
        <span className="ai-config">
          {settings
            ? `${PROVIDER_LABELS[settings.ai.provider]} · ${modelFor(settings, settings.ai.provider)}`
            : "…"}
        </span>
        <label className="ai-speak-toggle">
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={(e) => setSpeakReplies(e.target.checked)}
          />
          Speak replies
        </label>
      </div>

      <div className="ai-response-area">
        {error && <div className="ai-error">{error}</div>}
        {!error && response && <div className="ai-response-text">{response}</div>}
        {!error && !response && !streaming && !recording && (
          hasKey ? (
            <div className="ai-empty">Ask something below, or use the mic…</div>
          ) : (
            <div className="ai-empty">
              No API key set.
              <button
                className="ai-settings-link"
                onClick={() => invoke("open_settings", { section: "ai" })}
              >
                Open Settings…
              </button>
            </div>
          )
        )}
        {recording && <div className="ai-empty">Listening…</div>}
        {streaming && !response && <div className="ai-empty">Thinking…</div>}
      </div>

      {response && !streaming && (
        <button className="ai-insert-btn" onClick={insert}>
          Insert into focused field
        </button>
      )}

      <div className="ai-input-row">
        <button
          className={`ai-mic-btn ${recording ? "ai-mic-active" : ""}`}
          onClick={recordAndSend}
          disabled={streaming || recording || !hasKey}
          title="Speak your prompt"
        >
          🎤
        </button>
        <textarea
          className="ai-input"
          placeholder="Ask anything…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="ai-send-btn" onClick={() => send()} disabled={streaming || !hasKey}>
          {streaming ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
