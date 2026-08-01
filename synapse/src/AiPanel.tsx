import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./AiPanel.css";

type Provider = "anthropic" | "openai";

export default function AiPanel() {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [status, setStatus] = useState<Record<Provider, boolean>>({ anthropic: false, openai: false });
  const [keyInput, setKeyInput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [error, setError] = useState("");
  const responseRef = useRef("");
  const speakRepliesRef = useRef(speakReplies);
  speakRepliesRef.current = speakReplies;

  function refreshStatus() {
    invoke<Record<Provider, boolean>>("provider_status").then(setStatus);
  }

  useEffect(refreshStatus, []);

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

  // Only clear the input once the key is confirmed stored — wiping it first
  // meant a failed save silently ate the key the user had just typed.
  async function saveKey() {
    if (!keyInput.trim()) return;
    try {
      setError("");
      await invoke("set_api_key", { provider, key: keyInput.trim() });
      setKeyInput("");
      refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  function send(overridePrompt?: string) {
    const text = (overridePrompt ?? prompt).trim();
    if (!text || streaming) return;
    responseRef.current = "";
    setResponse("");
    setError("");
    setStreaming(true);
    invoke("send_ai_message", { provider, prompt: text });
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

  const hasKey = status[provider];

  return (
    <div className="ai-root">
      <div className="ai-provider-row">
        <select
          className="ai-provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <span className={`ai-key-badge ${hasKey ? "ai-key-ok" : "ai-key-missing"}`}>
          {hasKey ? "Key set" : "No key"}
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

      {!hasKey && (
        <div className="ai-key-form">
          <input
            className="ai-key-input"
            type="password"
            placeholder={`${provider === "anthropic" ? "Anthropic" : "OpenAI"} API key`}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveKey()}
          />
          <button className="ai-key-save" onClick={saveKey}>
            Save
          </button>
        </div>
      )}

      <div className="ai-response-area">
        {error && <div className="ai-error">{error}</div>}
        {!error && response && <div className="ai-response-text">{response}</div>}
        {!error && !response && !streaming && !recording && (
          <div className="ai-empty">Ask something below, or use the mic…</div>
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
