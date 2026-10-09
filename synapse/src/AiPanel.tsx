import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import { chooseGreeting } from "./greetings";
import { openOrbMicrophone, voiceCommand } from "./orbMicrophone";
import { reduceDesktopContext, type DesktopContextEvent } from "./desktopChoices";
import "./AiPanel.css";

type OrbState =
  | "idle"
  | "loading"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "acting"
  | "approval"
  | "error";
const LABELS: Record<OrbState, string> = {
  idle: "Ready",
  loading: "Starting",
  listening: "Listening",
  transcribing: "Transcribing",
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
  const [typing, setTyping] = useState(false);
  const [addressRequired, setAddressRequired] = useState(true);
  const [voicePrefix, setVoicePrefix] = useState("Synapse");
  const [voiceHint, setVoiceHint] = useState("");
  const [draft, setDraft] = useState("");
  const [desktopContext, setDesktopContext] = useState<DesktopContextEvent | null>(null);
  const choiceRef = useRef<(setId: string, choiceId: string) => void>(() => {});
  const dismissRef = useRef<() => void>(() => {});
  const submitRef = useRef<(text: string) => void>(() => {});
  const closeRef = useRef(() => {});
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const surfaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = getCurrentWindow();
    let disposed = false;
    let opened = false;
    let revision = 0;
    let session: number | null = null;
    let turn = 0;
    let hasChoices = false;
    let microphone: AbortController | null = null;
    let voiceOptions = { required: true, prefix: "Synapse" };
    let speech: {
      generation: number | null;
      turn: number;
      resolve: () => void;
      reject: (cause: unknown) => void;
    } | null = null;

    function cancel() {
      hasChoices = false;
      setDesktopContext(null);
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
        if (args.silent) resolve();
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
      let submitting = false;
      let receiving = false;
      setError("");
      setVoiceHint("");
      setState("loading");
      try {
        const settings = await invoke<Settings>("get_settings");
        if (!active()) return;
        const typed = settings.ai.typing_mode;
        setTyping(typed);
        setAddressRequired(settings.ai.voice_address_required);
        voiceOptions = {
          required: settings.ai.voice_address_required,
          prefix: settings.ai.voice_prefix?.trim() || "Synapse",
        };
        setVoicePrefix(voiceOptions.prefix);
        await invoke("set_ai_input_mode", { typing: typed });
        if (!active()) return;
        const id = await invoke<number>("begin_ai_session", { silent: typed });
        if (!active()) {
          await invoke("end_ai_session", { session: id });
          return;
        }
        session = id;
        turn = 0;
        const submit = (text: string, selection?: { setId: string; choiceId: string }) => {
          if (!active() || !text.trim() || submitting) return;
          submitting = true;
          const inputTurn = ++turn;
          speech?.reject(new Error("Reply interrupted"));
          speech = null;
          setError("");
          setState("thinking");
          hasChoices = false;
          setDesktopContext(null);
          void (async () => {
            try {
              await invoke("interrupt_ai_reply", { session: id, turn: inputTurn });
              if (!active() || turn !== inputTurn) return;
              setAnnouncement(text);
              await speak(selection ? "respond_desktop_choice" : "send_ai_message", {
                ...(selection ?? { prompt: text }),
                session: id,
                turn: inputTurn,
                silent: typed,
              });
              if (active() && turn === inputTurn) setState(typed ? "idle" : "listening");
            } catch (cause) {
              if (active() && turn === inputTurn) {
                setError(String(cause));
                setState("error");
              }
            } finally {
              submitting = false;
              if (active() && turn === inputTurn) receiving = true;
            }
          })();
        };
        submitRef.current = (text) => submit(text);
        choiceRef.current = (setId, choiceId) =>
          submit("Open selected result", { setId, choiceId });
        dismissRef.current = () => {
          hasChoices = false;
          setDesktopContext(null);
          void invoke("dismiss_desktop_choices", { session: id }).catch((cause) =>
            setError(String(cause)),
          );
        };
        if (typed) {
          setState("idle");
          setAnnouncement("Type a command to start.");
          return;
        }
        const controller = new AbortController();
        microphone = controller;
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
            if (!active() || !receiving || submitting || speech) return;
            setVoiceHint("Pause after your command.");
          },
          (samples, sampleRate) => {
            if (!active() || !receiving || submitting || speech) return;
            receiving = false;
            let inputTurn = turn;
            const current = () => active() && turn === inputTurn;
            void (async () => {
              try {
                if (!current()) return;
                setState("transcribing");
                const transcript = await invoke<string>("transcribe_for_ai", {
                  session: id,
                  turn: inputTurn,
                  samples,
                  sampleRate,
                });
                if (!current()) return;
                const command = voiceCommand(
                  transcript,
                  voiceOptions.required,
                  voiceOptions.prefix,
                );
                if (!command) {
                  setVoiceHint(
                    transcript.trim()
                      ? `Start with “${voiceOptions.prefix}”. Heard: ${transcript.trim().slice(0, 36)}`
                      : "No speech recognised. Try closer to the mic.",
                  );
                  setState("listening");
                  return;
                }
                if (command) {
                  setVoiceHint("");
                  inputTurn = ++turn;
                  await invoke("interrupt_ai_reply", { session: id, turn: inputTurn });
                  if (!current()) return;
                  setState("thinking");
                  hasChoices = false;
                  setDesktopContext(null);
                  setAnnouncement(command);
                  await speak("send_ai_message", {
                    prompt: command,
                    session: id,
                    turn: inputTurn,
                  });
                }
                if (current()) setState("listening");
              } catch (cause) {
                if (current()) fail(cause);
              } finally {
                if (current()) receiving = true;
              }
            })();
          },
          (value) => {
            if (active()) setLevel(Math.min(1, value / (settings.voice.speech_threshold * 2)));
          },
          fail,
          () => active() && receiving && !submitting && !speech,
        );
        if (!active() || turn !== 0) return;
        const greeting = chooseGreeting(settings.ai.custom_greetings);
        setAnnouncement(greeting);
        try {
          await speak("speak_ai_greeting", { text: greeting, session: id, turn: 0 });
          if (active() && turn === 0) {
            receiving = true;
            setState("listening");
          }
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
      listen<DesktopContextEvent>("ai-desktop-context", ({ payload }) => {
        if (
          !opened ||
          session === null ||
          payload.session !== session ||
          payload.turn !== turn ||
          speech?.generation !== payload.generation
        )
          return;
        hasChoices = !!payload.choices;
        setDesktopContext(
          (context) => reduceDesktopContext({ session: session!, turn, context }, payload).context,
        );
      }),
      listen<Settings>("settings-changed", ({ payload }) => {
        voiceOptions = {
          required: payload.ai.voice_address_required,
          prefix: payload.ai.voice_prefix?.trim() || "Synapse",
        };
        setVoicePrefix(voiceOptions.prefix);
        setAddressRequired(voiceOptions.required);
        setVoiceHint("");
      }),
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
      if (event.key === "Escape") {
        if (hasChoices) dismissRef.current();
        else close();
      }
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

  const expanded = desktopContext !== null;
  useEffect(() => {
    const resize = () => {
      void invoke("set_ai_input_mode", {
        typing,
        expanded,
        contentHeight: expanded
          ? Math.ceil(surfaceRef.current?.getBoundingClientRect().height ?? 320)
          : null,
      }).catch((cause) => setError(String(cause)));
    };
    resize();
    if (!expanded || !surfaceRef.current) return;
    const observer = new ResizeObserver(resize);
    observer.observe(surfaceRef.current);
    return () => observer.disconnect();
  }, [typing, expanded]);

  return (
    <main
      ref={surfaceRef}
      className={`orb-root${typing ? " orb-typing" : ""}${desktopContext ? " orb-expanded" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <div className="orb-header">
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
            {(error || (!typing && state === "listening")) && (
              <small className="orb-error-detail">
                {error ||
                  voiceHint ||
                  (addressRequired
                    ? `Say “${voicePrefix}, …” then pause.`
                    : "Speak, then pause to send.")}
              </small>
            )}
          </span>
        </button>
        {expanded && (
          <div className="orb-status">
            <span>{LABELS[state]}</span>
            {(error || voiceHint) && <small>{error || voiceHint}</small>}
          </div>
        )}
        {expanded && (
          <button
            className="orb-dismiss"
            type="button"
            aria-label="Dismiss results"
            title="Dismiss results"
            onClick={() => dismissRef.current()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        )}
      </div>
      {desktopContext && (
        <section className="orb-results" aria-label="Desktop assistant results">
          {desktopContext.choices ? (
            <h2>
              {desktopContext.choices.items.length === 1 ? "Found a match" : "Choose a match"}
            </h2>
          ) : (
            <p className="orb-answer" role="status">
              {desktopContext.question}
            </p>
          )}
          {desktopContext.choices && (
            <ol className="orb-choices">
              {desktopContext.choices.items.map((choice, index) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    aria-label={`Open ${choice.name}, ${choice.location}`}
                    title={`${choice.name}\n${choice.location.replace(/^\\\\\?\\/, "")}`}
                    disabled={["thinking", "acting", "approval", "transcribing"].includes(state)}
                    onClick={() => choiceRef.current(desktopContext.choices!.id, choice.id)}
                  >
                    <svg
                      className="orb-choice-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {choice.kind === "folder" ? (
                        <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
                      ) : choice.kind === "app" ? (
                        <>
                          <rect x="3" y="4" width="18" height="16" rx="2" />
                          <path d="M3 9h18M7 6.5h.01" />
                        </>
                      ) : (
                        <>
                          <path d="M14 3H5v18h14V8Zm0 0v5h5M8 13h8M8 17h6" />
                        </>
                      )}
                    </svg>
                    <span className="orb-choice-copy">
                      <strong>{choice.name}</strong>
                      <small>
                        {desktopContext.choices!.items.length > 1 && `${index + 1} · `}
                        {choice.kind === "app"
                          ? choice.location
                          : choice.location
                              .replace(/^\\\\\?\\/, "")
                              .replace(/.*[\\/](Desktop|Documents|Downloads)(?=[\\/]|$)/i, "$1")}
                      </small>
                    </span>
                    <span className="orb-choice-action" aria-hidden="true">
                      Open{" "}
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12h14m-5-5 5 5-5 5" />
                      </svg>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {desktopContext.choices && desktopContext.partial && (
            <p className="orb-search-note">Limited search</p>
          )}
        </section>
      )}
      {typing && (
        <form
          className="orb-command"
          onSubmit={(event) => {
            event.preventDefault();
            submitRef.current(draft);
            setDraft("");
          }}
        >
          <input
            aria-label="Command"
            placeholder="Ask Synapse…"
            value={draft}
            maxLength={10000}
            onChange={(event) => setDraft(event.target.value)}
            disabled={["thinking", "acting", "approval"].includes(state)}
          />
          <button disabled={!draft.trim() || ["thinking", "acting", "approval"].includes(state)}>
            Send
          </button>
        </form>
      )}
      <span id="orb-announcement" className="orb-announcement" role={error ? "alert" : "status"}>
        {error ||
          (state === "listening"
            ? voiceHint ||
              (addressRequired
                ? `Say “${voicePrefix}” and your command, then pause.`
                : "Listening. Speak, then pause to send.")
            : announcement)}
      </span>
    </main>
  );
}
