import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./Notepad.css";

const SAVE_DEBOUNCE_MS = 500;

export default function Notepad() {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Timers and window-level listeners fire outside the render that created
  // them, so they read the text and destination from here rather than from a
  // captured `content`/`currentPath` — a stale closure would write yesterday's
  // text, or write it to the file the user just navigated away from.
  const latest = useRef<{ content: string; path: string | null }>({
    content: "",
    path: null,
  });
  useEffect(() => {
    latest.current = { content, path: currentPath };
  }, [content, currentPath]);

  useEffect(() => {
    invoke<string>("load_note")
      .then((text) => {
        setContent(text);
        setLoaded(true);
      })
      .catch((e) => {
        setError(`Could not load note: ${e}`);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    const base = currentPath ? currentPath.split(/[\\/]/).pop() : "Notepad";
    getCurrentWindow().setTitle(`Synapse - ${base}${dirty ? " *" : ""}`);
  }, [dirty, currentPath]);

  // The single writer. `path === null` means the persistent app-data note
  // (PRD §4.3); a non-null path means the user opened or "Save As"-ed a real
  // file and that file is now the destination for *every* save, autosave
  // included. Routing both through here is what stops background autosaves
  // from clobbering the internal note while an external file is open.
  const persist = useCallback(async (text: string, path: string | null) => {
    try {
      if (path) {
        await invoke("save_note_to", { content: text, path });
      } else {
        await invoke("save_note", { content: text });
      }
      setError(null);
      // Only clear the dirty flag if nothing was typed while the write was in
      // flight, otherwise those keystrokes look saved when they aren't.
      if (latest.current.content === text) setDirty(false);
    } catch (e) {
      setError(`Could not save: ${e}`);
    }
  }, []);

  // Debounced autosave, re-armed whenever the text or the destination changes.
  useEffect(() => {
    if (!loaded || !dirty) return;
    const timer = setTimeout(() => {
      void persist(content, currentPath);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content, currentPath, dirty, loaded, persist]);

  // The debounce alone would lose the last ~500ms of edits if the user closes
  // the window right after typing — flush immediately on blur too.
  useEffect(() => {
    const flush = () => {
      if (dirty) void persist(content, currentPath);
    };
    window.addEventListener("blur", flush);
    return () => window.removeEventListener("blur", flush);
  }, [content, currentPath, dirty, persist]);

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

  async function handleSave() {
    await persist(content, currentPath);
  }

  async function handleSaveAs() {
    const path = await save({
      defaultPath: currentPath ?? "notepad.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!path) return;
    setCurrentPath(path);
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
    if (dirty) await persist(content, currentPath);
    try {
      const text = await invoke<string>("load_note_from", { path });
      setContent(text);
      setCurrentPath(path);
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(`Could not open file: ${e}`);
    }
  }

  if (!loaded) return null;

  return (
    <div className="notepad-root">
      <div className="notepad-toolbar">
        <button className="notepad-toolbar-btn" onClick={handleSave}>
          Save
        </button>
        <button className="notepad-toolbar-btn" onClick={handleSaveAs}>
          Save As…
        </button>
        <button className="notepad-toolbar-btn" onClick={handleOpen}>
          Open…
        </button>
      </div>
      {error && <div className="notepad-error">{error}</div>}
      <textarea
        className="notepad-textarea"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Start typing…"
        autoFocus
        spellCheck={false}
      />
    </div>
  );
}
