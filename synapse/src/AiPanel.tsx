import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import { chooseGreeting } from "./greetings";
import { openOrbMicrophone } from "./orbMicrophone";
import "./AiPanel.css";

type OrbState =
  "idle" | "loading" | "listening" | "thinking" | "speaking" | "acting" | "approval" | "error";
const LABELS: Record<OrbState, string> = {
  idle: "Ready",
  loading: "Starting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  acting: "Working",
  approval: "Review action",
  error: "Stopped",
};

export default function AiPanel() {
  const [state, setState] = useState<OrbState>("idle");
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const closeRef = useRef(() => {});
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const panel = getCurrentWindow();
    let disposed = false;
    let opened = false;
    let revision = 0;
    let session: number | null = null;
    let turn = 0;
    let microphone: AbortController | null = null;
    let speech: {
      generation: number | null;
      turn: number;
      resolve: () => void;
      reject: (cause: unknown) => void;
    } | null = null;

    function cancel() {
      revision++;
      microphone?.abort();
      microphone = null;
      speech?.reject(new Error("Conversation closed"));
      speech = null;
      if (session !== null) {
        void invoke("end_ai_session", { session }).catch(console.error);
        session = null;
      }
    }

    function close() {
      opened = false;
      cancel();
      setState("idle");
      void panel.hide().catch((cause) => setError(String(cause)));
    }
    closeRef.current = close;

    // Wait for BOTH response generation and playback. Audio may finish first.
    async function speak(command: string, args: Record<string, unknown>) {
      const ended = new Promise<void>((resolve, reject) => {
        speech = { generation: null, turn, resolve, reject };
      });
      const pending = speech;
      try {
        const [reply] = await Promise.all([invoke<string | void>(command, args), ended]);
        if (speech !== pending) return;
        if (reply) setAnnouncement(reply);
        await invoke("finish_ai_reply", { session: args.session, turn: args.turn });
      } finally {
        if (speech === pending) speech = null;
      }
    }

    async function start() {
      if (disposed) return;
      cancel();
      opened = true;
      const run = revision;
      const active = () => !disposed && opened && revision === run;
      setError("");
      setState("loading");
      try {
        const settings = await invoke<Settings>("get_settings");
        if (!active()) return;
        const id = await invoke<number>("begin_ai_session");
        if (!active()) {
          await invoke("end_ai_session", { session: id });
          return;
        }
        session = id;
        turn = 0;
        const controller = new AbortController();
        microphone = controller;
        let interrupted = Promise.resolve();
        const fail = (cause: unknown) => {
          if (!active()) return;
          cancel();
          setError(String(cause));
          setState("error");
        };
        await openOrbMicrophone(
          settings.voice,
          controller.signal,
          () => {
            if (!active()) return;
            turn++;
            speech?.reject(new Error("Reply interrupted"));
            speech = null;
            setState("listening");
            interrupted = invoke<void>("interrupt_ai_reply", { session: id, turn });
            void interrupted.catch(fail);
          },
          (samples, sampleRate) => {
            const inputTurn = turn;
            const current = () => active() && turn === inputTurn;
            void (async () => {
              try {
                await interrupted;
                if (!current()) return;
                setState("thinking");
                const transcript = await invoke<string>("transcribe_for_ai", {
                  session: id,
                  turn: inputTurn,
                  samples,
                  sampleRate,
                });
                if (!current()) return;
                if (transcript.trim()) {
                  setAnnouncement(transcript);
                  await speak("send_ai_message", {
                    prompt: transcript,
                    session: id,
                    turn: inputTurn,
                  });
                }
                if (current()) setState("listening");
              } catch (cause) {
                if (current()) fail(cause);
              }
            })();
          },
          (value) => {
            if (active()) setLevel(Math.min(1, value / 0.22));
          },
          fail,
        );
        if (!active() || turn !== 0) return;
        const greeting = chooseGreeting(settings.ai.custom_greetings);
        setAnnouncement(greeting);
        try {
          await speak("speak_ai_greeting", { text: greeting, session: id, turn: 0 });
          if (active() && turn === 0) setState("listening");
        } catch (cause) {
          if (active() && turn === 0) fail(cause);
        }
      } catch (cause) {
        if (!active()) return;
        cancel();
        setError(String(cause));
        setState("error");
      }
    }

    const subscriptions = [
      listen("ai-emergency-stop", close),
      listen<{ generation: number; state: "acting" | "approval" }>(
        "ai-task-state",
        ({ payload }) => {
          if (opened && speech?.generation === payload.generation) setState(payload.state);
        },
      ),
      listen<{ session: number; turn: number; generation: number }>(
        "ai-speech-requested",
        ({ payload }) => {
          if (payload.session === session && speech?.turn === payload.turn)
            speech.generation = payload.generation;
        },
      ),
      listen<number>("tts-started", ({ payload }) => {
        if (speech?.generation === payload) setState("speaking");
      }),
      listen<number>("tts-ended", ({ payload }) => {
        if (speech?.generation === payload) speech.resolve();
      }),
      listen<{ generation: number; message: string }>("tts-generation-error", ({ payload }) => {
        if (speech?.generation === payload.generation) speech.reject(payload.message);
      }),
      listen<number>("tts-playback-error", ({ payload }) => {
        if (speech?.generation === payload)
          speech.reject("Audio output failed. Check your speakers and reopen AI.");
      }),
      listen<number>("tts-requested", ({ payload }) => {
        if (speech?.generation != null && speech.generation !== payload) {
          speech.reject(
            "Another speech task interrupted this conversation. Reopen AI to continue.",
          );
        }
      }),
      panel.onCloseRequested(close),
    ];
    const shown = Promise.all(subscriptions).then(() =>
      listen("ai-shown", () => {
        void start();
      }),
    );
    void shown
      .then(async () => {
        if (await panel.isVisible()) {
          if (!disposed && !opened) await start();
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setError(String(cause));
          setState("error");
        }
      });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      opened = false;
      cancel();
      [...subscriptions, shown].forEach((subscription) => {
        void subscription.then((unlisten) => unlisten()).catch(() => {});
      });
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <main
      className="orb-root"
      onContextMenu={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <button
        className={`orb orb-${state}`}
        style={{ "--orb-level": level } as CSSProperties}
        aria-label={`${LABELS[state]}. Drag to move; right-click or Escape to close.`}
        aria-describedby="orb-announcement"
        title={error || `${LABELS[state]}. Hold left button to move. Right-click to close.`}
        onPointerDown={(event) => {
          if (event.button === 0) pressOrigin.current = { x: event.screenX, y: event.screenY };
        }}
        onPointerMove={(event) => {
          const origin = pressOrigin.current;
          if (!origin) return;
          if (!(event.buttons & 1)) {
            pressOrigin.current = null;
            return;
          }
          if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) < 4) return;
          pressOrigin.current = null;
          void invoke("start_overlay_drag").catch((cause) => setError(String(cause)));
        }}
        onPointerUp={() => {
          pressOrigin.current = null;
        }}
        onPointerCancel={() => {
          pressOrigin.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") closeRef.current();
        }}
      >
        <span className="orb-visual">
          <span className="orb-core" />
        </span>
        <span className="orb-label" aria-hidden="true">
          <span>{LABELS[state]}</span>
          {error && <small className="orb-error-detail">{error}</small>}
        </span>
      </button>
      <span id="orb-announcement" className="orb-announcement" role={error ? "alert" : "status"}>
        {error || (state === "listening" ? "Listening. Speak, then pause to send." : announcement)}
      </span>
    </main>
  );
}
