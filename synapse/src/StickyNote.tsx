import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
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
///
/// A note can additionally be *linked* to a file on disk (Open… / Save to
/// file…), carried over from the Notepad save/open work in #1 when the single
/// Notepad became sticky notes. The link is per window and not persisted —
/// same as the Notepad it came from, where `currentPath` was component state.
export default function StickyNote({ id }: { id: string }) {
  const [content, setContent] = useState("");
  const [color, setColor] = useState("amber");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pickingColor, setPickingColor] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Timers and window-level listeners fire outside the render that created
  // them, so they read the text and destination from here rather than from a
  // captured `content`/`filePath` — a stale closure would write yesterday's
  // text, or write it to the file the user just navigated away from.
  const latest = useRef<{ content: string; path: string | null }>({ content: "", path: null });
  useEffect(() => {
    latest.current = { content, path: filePath };
  }, [content, filePath]);

  useEffect(() => {
    invoke<Note>("get_note", { id })
      .then((note) => {
        setContent(note.content);
        setColor(note.color);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [id]);

  /**
   * The single writer. The notes store is always written — it is the note's
   * identity, and a sticky note that stopped saving itself because a file was
   * linked would lose data the moment the window closed. A linked file is an
   * *additional* destination, not a replacement.
   *
   * This differs deliberately from the Notepad version in #1, where a non-null
   * path replaced the internal note. There, the internal note was a rival
   * destination and writing both was the bug; here the store is the note.
   */
  const persist = useCallback(
    async (text: string, path: string | null) => {
      try {
        await invoke("save_note_content", { id, content: text });
        if (path) await invoke("save_note_to", { content: text, path });
        setError(null);
        // Only clear the dirty flag if nothing was typed while the write was in
        // flight, otherwise those keystrokes look saved when they aren't.
        if (latest.current.content === text) setDirty(false);
      } catch (e) {
        setError(`Could not save: ${e}`);
      }
    },
    [id],
  );

  // Debounced autosave, re-armed whenever the text or the destination changes.
  useEffect(() => {
    if (!loaded || !dirty) return;
    const timer = setTimeout(() => {
      void persist(content, filePath);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content, filePath, dirty, loaded, persist]);

  // Two flush paths, because neither covers the other. `blur` catches clicking
  // away mid-sentence; `onCloseRequested` catches the window being destroyed,
  // where a pending 500 ms debounce would otherwise die with the webview —
  // and unlike the old single Notepad, these windows really are destroyed.
  useEffect(() => {
    const flush = () => {
      if (dirty) void persist(latest.current.content, latest.current.path);
    };
    window.addEventListener("blur", flush);
    const unlisten = getCurrentWindow().onCloseRequested(() => flush());
    return () => {
      window.removeEventListener("blur", flush);
      unlisten.then((f) => f());
    };
  }, [dirty, persist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void persist(latest.current.content, latest.current.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [persist]);

  function onChange(text: string) {
    setContent(text);
    setDirty(true);
  }

  function pickColor(next: string) {
    setColor(next);
    setPickingColor(false);
    invoke("set_note_color", { id, color: next });
  }

  async function handleSaveAs() {
    const path = await save({
      defaultPath: filePath ?? "note.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!path) return;
    setFilePath(path);
    await persist(content, path);
  }

  async function handleOpen() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    // Replacing the buffer would silently drop unsaved edits to whatever was
    // open before, so commit them to their own destination first.
    if (dirty) await persist(content, filePath);
    try {
      const text = await invoke<string>("load_note_from", { path });
      setContent(text);
      setFilePath(path);
      setDirty(false);
      setError(null);
      // The note now holds the file's text, so the store has to agree — a
      // crash before the next keystroke would otherwise resurrect the old note.
      await persist(text, path);
    } catch (e) {
      setError(`Could not open file: ${e}`);
    }
  }

  if (!loaded) return null;

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;

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
          onClick={handleOpen}
          title="Open a text file into this note"
          aria-label="Open file"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
        </button>
        <button
          className="note-head-btn"
          onClick={handleSaveAs}
          title={filePath ? `Save a copy (Ctrl+S writes to ${fileName})` : "Save this note to a file"}
          aria-label="Save to file"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" />
          </svg>
        </button>
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

      {/* Save/open failures were swallowed in the original Notepad, leaving the
          dirty flag stale with no sign anything had gone wrong. */}
      {error && <div className="note-error">{error}</div>}

      <textarea
        className="note-textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Start typing…"
        autoFocus
        spellCheck={false}
      />

      {fileName && (
        <footer className="note-file" title={filePath ?? undefined}>
          {fileName}
          {dirty ? " •" : ""}
        </footer>
      )}
    </div>
  );
}
