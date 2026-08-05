import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NOTE_COLORS } from "./noteColors";
import "./StickyNote.css";

const SAVE_DEBOUNCE_MS = 500;

interface Note {
  id: string;
  content: string;
  color: string;
}

/// One free-floating sticky note. The window is undecorated, so the header
/// here IS the title bar: it owns dragging, the colour picker, and close.
export default function StickyNote({ id }: { id: string }) {
  const [content, setContent] = useState("");
  const [color, setColor] = useState("amber");
  const [loaded, setLoaded] = useState(false);
  const [pickingColor, setPickingColor] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef("");
  contentRef.current = content;

  useEffect(() => {
    invoke<Note>("get_note", { id })
      .then((note) => {
        setContent(note.content);
        setColor(note.color);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [id]);

  function flush() {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    invoke("save_note_content", { id, content: contentRef.current });
  }

  // Two flush paths, because neither covers the other. `blur` catches clicking
  // away mid-sentence; `onCloseRequested` catches the window being destroyed,
  // where a pending 500 ms debounce would otherwise die with the webview —
  // and unlike the old single Notepad, these windows really are destroyed.
  useEffect(() => {
    window.addEventListener("blur", flush);
    const unlisten = getCurrentWindow().onCloseRequested(() => flush());
    return () => {
      window.removeEventListener("blur", flush);
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function onChange(text: string) {
    setContent(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      invoke("save_note_content", { id, content: text });
    }, SAVE_DEBOUNCE_MS);
  }

  function pickColor(next: string) {
    setColor(next);
    setPickingColor(false);
    invoke("set_note_color", { id, color: next });
  }

  if (!loaded) return null;

  return (
    <div className={`note-root note-${color}`}>
      {/* data-tauri-drag-region makes the header the window's drag handle;
          interactive children opt out with their own handlers. */}
      <header className="note-head" data-tauri-drag-region>
        <button
          className="note-swatch"
          onClick={() => setPickingColor((v) => !v)}
          title="Change colour"
          aria-label="Change colour"
          aria-expanded={pickingColor}
        />
        <span className="note-grip" data-tauri-drag-region />
        <button
          className="note-head-btn"
          onClick={() => invoke("create_note", { color })}
          title="New note"
          aria-label="New note"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 6v12M6 12h12" />
          </svg>
        </button>
        <button
          className="note-head-btn"
          onClick={() => invoke("close_note_window", { id })}
          title="Close (the note is kept)"
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </header>

      {pickingColor && (
        <div className="note-colors">
          {NOTE_COLORS.map((c) => (
            <button
              key={c.id}
              className={`note-color-dot note-color-${c.id}${c.id === color ? " note-color-on" : ""}`}
              onClick={() => pickColor(c.id)}
              title={c.label}
              aria-label={c.label}
            />
          ))}
        </div>
      )}

      <textarea
        className="note-textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Start typing…"
        autoFocus
        spellCheck={false}
      />
    </div>
  );
}
