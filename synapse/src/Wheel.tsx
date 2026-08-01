import { useEffect, useState } from "react";
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

type Mode = "menu" | "listening" | "error" | "toast";

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
  detail?: string;
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

export default function Wheel() {
  const [hovered, setHovered] = useState<WedgeId | null>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      setMode("menu");
    });
    const unlistenListening = listen("dictation-listening", () => setMode("listening"));
    const unlistenError = listen<string>("dictation-error", (e) => {
      setError(e.payload);
      setMode("error");
    });
    const unlistenToast = listen<string>("toast", (e) => {
      setToast(e.payload);
      setMode("toast");
    });

    return () => {
      unlistenShown.then((f) => f());
      unlistenListening.then((f) => f());
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
    return (
      <StatusCircle
        title="Listening…"
        detail="click to stop"
        onClick={() => invoke("stop_dictation")}
      >
        <div className="listening-dots">
          <span className="listening-dot" />
          <span className="listening-dot" />
          <span className="listening-dot" />
        </div>
      </StatusCircle>
    );
  }

  if (mode === "toast") {
    const [headline, ...rest] = toast.split("\n");
    return (
      <StatusCircle title={headline} detail={rest.join(" ")}>
        <svg viewBox="0 0 24 24" className="status-check">
          <path d="M20 6L9 17l-5-5" />
        </svg>
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
        {/* Radius must match R_INNER exactly — any smaller and the difference
            shows through as a transparent ring of desktop wallpaper. */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R_INNER}
          className="hub-circle"
          onClick={() => invoke("dismiss_overlay")}
        />
      </svg>

      <div className="hub-label">
        <span className="hub-title">{hoveredWedge ? hoveredWedge.label : "Pick an action"}</span>
        <span className="hub-hint">esc to cancel</span>
      </div>
    </div>
  );
}
