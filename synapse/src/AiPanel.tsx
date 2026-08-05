import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PROVIDER_LABELS, modelFor, type Provider, type Settings } from "./models";
import "./AiPanel.css";

/// idle → listening → thinking → speaking → idle.
/// "thinking" covers both transcription and generation: from the user's side
/// they are the same wait, and splitting them would flicker.
type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface Turn {
  role: "you" | "ai";
  text: string;
}

interface DictationTick {
  level: number;
  elapsed_ms: number;
  heard_speech: boolean;
}

const LEVEL_CEILING = 0.22;

const HINTS: Record<OrbState, string> = {
  idle: "Click to talk",
  listening: "Listening — click when you're done",
  thinking: "Thinking…",
  speaking: "Click to interrupt",
};

export default function AiPanel() {
  // Config is owned by the Settings window; this panel just reads it.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [state, setState] = useState<OrbState>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [showComposer, setShowComposer] = useState(false);

  const streamRef = useRef("");
  const stateRef = useRef<OrbState>("idle");
  stateRef.current = state;
  const transcriptRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    invoke<Settings>("get_settings").then((s) => {
      setSettings(s);
      invoke<Record<Provider, boolean>>("provider_status").then((status) =>
        setHasKey(status[s.ai.provider]),
      );
    });
  }, []);

  useEffect(refresh, [refresh]);

  // Hidden rather than closed, so an open panel would otherwise keep showing
  // stale config after Settings changed it.
  useEffect(() => {
    const unlisten = listen<Settings>("settings-changed", refresh);
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh]);

  useEffect(() => {
    const subs = [
      listen<string>("ai-delta", (e) => {
        streamRef.current += e.payload;
        setStreamingText(streamRef.current);
      }),
      listen<string>("ai-done", (e) => {
        setTurns((t) => [...t, { role: "ai", text: e.payload }]);
        streamRef.current = "";
        setStreamingText("");
        // If audio is coming, tts-started takes over; otherwise we're done.
        setState((s) => (s === "speaking" ? s : "idle"));
      }),
      listen<string>("ai-error", (e) => {
        setError(e.payload);
        streamRef.current = "";
        setStreamingText("");
        setState("idle");
      }),
      listen("tts-started", () => setState("speaking")),
      listen("tts-ended", () =>
        // Functional update: dictation can start again before this lands.
        setState((s) => (s === "speaking" ? "idle" : s)),
      ),
      listen<string>("tts-error", (e) => setError(e.payload)),
      listen<DictationTick>("dictation-tick", (e) => setLevel(e.payload.level)),
    ];
    return () => {
      subs.forEach((s) => s.then((f) => f()));
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns, streamingText]);

  function ask(text: string) {
    const prompt = text.trim();
    if (!prompt) return;
    setError("");
    setTurns((t) => [...t, { role: "you", text: prompt }]);
    streamRef.current = "";
    setStreamingText("");
    setState("thinking");
    invoke("send_ai_message", { prompt, speak: true });
  }

  async function listen_() {
    setError("");
    setState("listening");
    setLevel(0);
    try {
      const transcript = await invoke<string>("transcribe_for_ai");
      if (transcript.trim()) {
        ask(transcript);
      } else {
        setState("idle");
      }
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  }

  function onOrbClick() {
    if (!hasKey) return;
    switch (stateRef.current) {
      case "idle":
        listen_();
        break;
      case "listening":
        // The recording ends; the await in listen_() resolves with the text.
        setState("thinking");
        invoke("stop_dictation");
        break;
      case "speaking":
        invoke("stop_speaking");
        setState("idle");
        break;
      case "thinking":
        break; // nothing sensible to interrupt yet
    }
  }

  function newConversation() {
    invoke("stop_speaking");
    invoke("clear_conversation");
    setTurns([]);
    streamRef.current = "";
    setStreamingText("");
    setError("");
    setState("idle");
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (stateRef.current === "speaking") invoke("stop_speaking");
        else if (stateRef.current === "listening") invoke("stop_dictation");
        else getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const aiTurns = turns.filter((t) => t.role === "ai");
  const lastReply = streamingText || (aiTurns.length ? aiTurns[aiTurns.length - 1].text : "");
  const orbScale = state === "listening" ? 1 + Math.min(1, level / LEVEL_CEILING) * 0.18 : 1;

  return (
    <div className="orb-root">
      <header className="orb-bar" data-tauri-drag-region>
        <span className="orb-model" data-tauri-drag-region>
          {settings
            ? `${PROVIDER_LABELS[settings.ai.provider]} · ${modelFor(settings, settings.ai.provider)}`
            : "…"}
        </span>
        <button
          className="orb-bar-btn"
          onClick={newConversation}
          disabled={turns.length === 0}
          title="Start a new conversation"
        >
          New
        </button>
        <button
          className="orb-bar-btn"
          onClick={() => getCurrentWindow().hide()}
          title="Close"
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </header>

      <div className="orb-stage">
        <button
          className={`orb orb-${state}`}
          style={{ transform: `scale(${orbScale})` }}
          onClick={onOrbClick}
          disabled={!hasKey}
          aria-label={HINTS[state]}
        >
          <span className="orb-core" />
          <span className="orb-ring orb-ring-1" />
          <span className="orb-ring orb-ring-2" />
        </button>
        <p className="orb-hint">{hasKey ? HINTS[state] : "Add an API key to start"}</p>
      </div>

      <div className="orb-transcript" ref={transcriptRef}>
        {error && <div className="orb-error">{error}</div>}

        {!hasKey && !error && (
          <div className="orb-empty">
            <p className="orb-empty-body">
              Synapse talks to your own AI account. Add a key and this becomes a voice you can
              think out loud at.
            </p>
            <button
              className="orb-link"
              onClick={() => invoke("open_settings", { section: "ai" })}
            >
              Open Settings
            </button>
          </div>
        )}

        {hasKey && turns.length === 0 && !error && (
          <div className="orb-empty">
            <p className="orb-empty-body">
              Click the orb and just talk. It answers out loud and remembers the conversation.
            </p>
          </div>
        )}

        {turns.map((turn, i) => (
          <p key={i} className={`orb-turn orb-turn-${turn.role}`}>
            {turn.text}
          </p>
        ))}
        {streamingText && <p className="orb-turn orb-turn-ai">{streamingText}</p>}
      </div>

      <footer className="orb-foot">
        {/* Typing stays available but de-emphasised. Voice is the point of this
            window; removing the keyboard entirely would still be a regression. */}
        {showComposer ? (
          <div className="orb-composer">
            <textarea
              className="orb-input"
              placeholder="Type instead…"
              value={typed}
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(typed);
                  setTyped("");
                  setShowComposer(false);
                }
              }}
            />
          </div>
        ) : (
          <button
            className="orb-link"
            onClick={() => setShowComposer(true)}
            disabled={!hasKey}
          >
            Type instead
          </button>
        )}
        {lastReply && state === "idle" && (
          <button
            className="orb-link"
            onClick={() => invoke("insert_ai_response", { content: lastReply })}
          >
            Insert into last window
          </button>
        )}
      </footer>
    </div>
  );
}
