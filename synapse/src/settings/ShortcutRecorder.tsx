import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { shortcutFromKey } from "./shortcutKeys";

export function ShortcutKeys({ value }: { value: string }) {
  return (
    <span className="set-keycaps">
      {value
        .split("+")
        .filter(Boolean)
        .map((key, index) => (
          <kbd key={index}>
            {key === "Enter" ? (
              <svg viewBox="0 0 24 24" role="img" aria-label="Enter">
                <path d="M19 4v10H5m5-5-5 5 5 5" />
              </svg>
            ) : (
              { Control: "Ctrl", Super: "Win", Space: "Space", Backspace: "Backspace" }[key] || key
            )}
          </kbd>
        ))}
    </span>
  );
}

export default function ShortcutRecorder({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [pressed, setPressed] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  useEffect(
    () => () => {
      if (active.current) void invoke("set_shortcut_recording", { recording: false });
    },
    [],
  );

  async function finish() {
    active.current = false;
    setRecording(false);
    setPressed("");
    try {
      await invoke("set_shortcut_recording", { recording: false });
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <div className="set-shortcut-control">
      <button
        type="button"
        className={`set-shortcut${recording ? " set-shortcut-recording" : ""}`}
        aria-label={`Record shortcut for ${label}`}
        aria-pressed={recording}
        onClick={async (event) => {
          const button = event.currentTarget;
          setError("");
          active.current = true;
          try {
            await invoke("set_shortcut_recording", { recording: true });
            if (!active.current || document.activeElement !== button) {
              await finish();
              return;
            }
            setRecording(true);
          } catch (cause) {
            active.current = false;
            setError(String(cause));
          }
        }}
        onBlur={() => {
          if (active.current) void finish();
        }}
        onKeyDown={(event) => {
          if (!recording) return;
          if (
            event.key === "Escape" ||
            (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey)
          ) {
            void finish();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          setPressed(
            [
              event.ctrlKey && "Control",
              event.altKey && "Alt",
              event.shiftKey && "Shift",
              event.metaKey && "Super",
            ]
              .filter(Boolean)
              .join("+"),
          );
          const shortcut = shortcutFromKey(event);
          if (shortcut) {
            onChange(shortcut);
            void finish();
          }
        }}
      >
        {recording ? (
          pressed ? (
            <>
              <ShortcutKeys value={pressed} />
              <span> + …</span>
            </>
          ) : (
            "Press a key combination…"
          )
        ) : value ? (
          <ShortcutKeys value={value} />
        ) : (
          "Click to record"
        )}
      </button>
      {optional && value && (
        <button
          className="set-clear-shortcut"
          aria-label={`Clear shortcut for ${label}`}
          title="Remove shortcut"
          onClick={() => onChange("")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      )}
      {error && (
        <span className="set-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
