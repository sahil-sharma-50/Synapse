import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WEDGES, WedgeId, wedgePath, iconPosition } from "./wedges";
import "./App.css";

// Keep SIZE in sync with OVERLAY_SIZE in src-tauri/src/lib.rs.
// R_OUTER is deliberately well inside SIZE/2 so the drop-shadow has room to
// fade out inside the window instead of clipping into a visible box.
const SIZE = 360;
const CENTER = SIZE / 2;
const R_OUTER = 150;
const R_INNER = 58;
const R_ICON = (R_OUTER + R_INNER) / 2;

/// Pointer travel, in px, before a press on the hub becomes a drag instead of
/// a dismiss. Small enough that a deliberate drag feels immediate, large
/// enough to survive the shake of an ordinary click.
const DRAG_THRESHOLD_PX = 4;

/// How long the meter can sit flat before we say something. Purely advisory —
/// with manual stop, nothing ends the recording but the user.
const NO_INPUT_HINT_MS = 6000;

const LEVEL_BARS = 5;
/// RMS at which a bar reaches full height. Normal speech peaks around 0.15;
/// anything above this is shouting and just pins the meter.
const LEVEL_CEILING = 0.22;

type Mode = "menu" | "listening" | "error" | "toast";

interface Toast {
  title: string;
  detail: string;
  path: string | null;
  tone: "ok" | "error";
}

interface DictationTick {
  level: number;
  elapsed_ms: number;
  heard_speech: boolean;
}

/// Shared circular panel for the overlay's non-menu states, so the icon and
/// text stack inside one circle instead of overlapping as separately-centred
/// absolute elements.
function StatusCircle({
  title,
  detail,
  tone,
  onClick,
  children,
}: {
  title: string;
  detail?: React.ReactNode;
  tone?: "error";
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="overlay-root">
      <div
        className={`status-circle${tone === "error" ? " status-circle-error" : ""}${onClick ? " status-clickable" : ""}`}
        onClick={onClick}
      >
        {children}
        <span className="status-title">{title}</span>
        {detail && <span className="status-detail">{detail}</span>}
      </div>
    </div>
  );
}

/// Five bars driven by real microphone RMS. The middle bars react hardest, so
/// the shape reads as a voice rather than a row of equal sliders.
function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const weights = [0.45, 0.75, 1, 0.75, 0.45];
  const norm = Math.min(1, level / LEVEL_CEILING);
  return (
    <div className={`level-meter${active ? "" : " level-meter-idle"}`}>
      {Array.from({ length: LEVEL_BARS }, (_, i) => (
        <span
          key={i}
          className="level-bar"
          style={active ? { height: `${5 + norm * weights[i] * 28}px` } : undefined}
        />
      ))}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function Wheel() {
  const [hovered, setHovered] = useState<WedgeId | null>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [tick, setTick] = useState<DictationTick | null>(null);

  // Drag bookkeeping for the hub. `dragged` has to be a ref, not state:
  // start_dragging hands the gesture to the OS, which calls ReleaseCapture and
  // stops delivering pointer events to the webview, so the flag must already
  // be set by the time the click handler might run.
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  function endPress() {
    pressOrigin.current = null;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && mode === "listening") {
        // Enter is the natural "I'm done talking" key and the overlay holds
        // focus while listening, so it is free for us to use.
        e.preventDefault();
        invoke("stop_dictation");
        return;
      }
      if (e.key !== "Escape") return;
      // While recording, Esc stops the capture; the backend then tears the
      // overlay down itself once it has finished.
      if (mode === "listening") invoke("stop_dictation");
      else invoke("dismiss_overlay");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  useEffect(() => {
    // The webview persists across window show/hide, so mode must be reset
    // explicitly by the Rust side rather than relying on component remount.
    const unlistenShown = listen("wheel-shown", () => {
      setError("");
      setTick(null);
      // A drag flag left set by an interrupted gesture would silently eat the
      // first hub click of the next summon.
      dragged.current = false;
      pressOrigin.current = null;
      setMode("menu");
    });
    const unlistenListening = listen("dictation-listening", () => {
      setTick(null);
      setMode("listening");
    });
    const unlistenTick = listen<DictationTick>("dictation-tick", (e) => setTick(e.payload));
    const unlistenError = listen<string>("dictation-error", (e) => {
      setError(e.payload);
      setMode("error");
    });
    const unlistenToast = listen<Toast>("toast", (e) => {
      setToast(e.payload);
      setMode("toast");
    });

    return () => {
      unlistenShown.then((f) => f());
      unlistenListening.then((f) => f());
      unlistenTick.then((f) => f());
      unlistenError.then((f) => f());
      unlistenToast.then((f) => f());
    };
  }, []);

  function selectWedge(id: WedgeId) {
    if (id === "stt") {
      setMode("listening"); // instant local feedback; backend event confirms it
      invoke("start_dictation");
    } else if (id === "quit") {
      invoke("force_quit"); // no confirmation, no toast — the process ends immediately
    } else {
      invoke("select_wedge", { wedge: id });
    }
  }

  const hoveredWedge = WEDGES.find((w) => w.id === hovered);

  if (mode === "listening") {
    const heard = tick?.heard_speech ?? false;
    const quietTooLong = !heard && (tick?.elapsed_ms ?? 0) > NO_INPUT_HINT_MS;
    return (
      <StatusCircle
        title="Listening…"
        detail={
          <>
            <span className="status-timer">{formatElapsed(tick?.elapsed_ms ?? 0)}</span>
            <br />
            {quietTooLong ? (
              <span className="status-warn">Not hearing anything — check your microphone</span>
            ) : (
              "enter or click to stop"
            )}
          </>
        }
        onClick={() => invoke("stop_dictation")}
      >
        <LevelMeter level={tick?.level ?? 0} active={heard} />
      </StatusCircle>
    );
  }

  if (mode === "toast" && toast) {
    const reveal = () => {
      if (toast.path) invoke("reveal_path", { path: toast.path });
      invoke("dismiss_overlay");
    };
    return (
      <StatusCircle
        title={toast.title}
        tone={toast.tone === "error" ? "error" : undefined}
        onClick={reveal}
        detail={
          <>
            <span className="status-path">{toast.detail}</span>
            {toast.path && <span className="status-action">Click to open</span>}
          </>
        }
      >
        {toast.tone === "ok" && (
          <svg viewBox="0 0 24 24" className="status-check">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </StatusCircle>
    );
  }

  if (mode === "error") {
    return <StatusCircle title="Dictation failed" detail={error} tone="error" />;
  }

  return (
    <div className="overlay-root" onClick={(e) => { if (e.target === e.currentTarget) invoke("dismiss_overlay"); }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { if (e.target === e.currentTarget) invoke("dismiss_overlay"); }}
      >
        {WEDGES.map((wedge, i) => {
          const d = wedgePath(i, WEDGES.length, CENTER, CENTER, R_OUTER, R_INNER);
          const { x, y } = iconPosition(i, WEDGES.length, CENTER, CENTER, R_ICON);
          const isHovered = hovered === wedge.id;
          return (
            <g
              key={wedge.id}
              className={`wedge${wedge.danger ? " wedge-danger" : ""}${isHovered ? " wedge-hovered" : ""}`}
              onMouseEnter={() => setHovered(wedge.id)}
              onMouseLeave={() => setHovered((h) => (h === wedge.id ? null : h))}
              onClick={() => selectWedge(wedge.id)}
            >
              <path d={d} className="wedge-slice" />
              <g transform={`translate(${x - 12} ${y - 12})`} className="wedge-icon">
                <path d={wedge.icon} />
              </g>
            </g>
          );
        })}
        {/* The hub is both the dismiss target and the drag handle.
            Radius must match R_INNER exactly — any smaller and the difference
            shows through as a transparent ring of desktop wallpaper. */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R_INNER}
          className="hub-circle"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            pressOrigin.current = { x: e.clientX, y: e.clientY };
            dragged.current = false;
          }}
          onPointerMove={(e) => {
            if (!pressOrigin.current || dragged.current) return;
            // The button came up without us seeing pointerup (it can be
            // swallowed mid-gesture); treat the press as over.
            if (e.buttons === 0) {
              endPress();
              return;
            }
            const dx = e.clientX - pressOrigin.current.x;
            const dy = e.clientY - pressOrigin.current.y;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            // Set before invoking: once the OS takes the drag we may never get
            // another event, and this flag is what suppresses the click.
            dragged.current = true;
            endPress();
            invoke("start_overlay_drag");
          }}
          onPointerUp={endPress}
          onPointerCancel={() => {
            endPress();
            dragged.current = false;
          }}
          onClick={() => {
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            invoke("dismiss_overlay");
          }}
        />
      </svg>

      <div className="hub-label">
        <span className="hub-title">{hoveredWedge ? hoveredWedge.label : "Pick an action"}</span>
        <span className="hub-hint">drag to move · esc to close</span>
      </div>
    </div>
  );
}
