import { useEffect, useRef, useState } from "react";
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    invoke<string>("load_note").then((text) => {
      setContent(text);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    const base = currentPath ? currentPath.split(/[\\/]/).pop() : "Notepad";
    getCurrentWindow().setTitle(dirty ? `Synapse - ${base} *` : `Synapse - ${base}`);
  }, [dirty, currentPath]);

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        invoke("save_note", { content });
      }
    };
    window.addEventListener("blur", flush);
    return () => window.removeEventListener("blur", flush);
  }, [content]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onChange(text: string) {
    setContent(text);
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke("save_note", { content: text });
    }, SAVE_DEBOUNCE_MS);
  }

  async function handleSave() {
    if (currentPath) {
      await invoke("save_note_as", { content, path: currentPath });
      setDirty(false);
    } else {
      await invoke("save_note", { content });
      setDirty(false);
    }
  }

  async function handleSaveAs() {
    const path = await save({
      defaultPath: "notepad.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (path) {
      await invoke("save_note_as", { content, path });
      setCurrentPath(path);
      setDirty(false);
    }
  }

  async function handleOpen() {
    const path = await open({
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (path && typeof path === "string") {
      const text = await invoke<string>("load_note_from", { path });
      setContent(text);
      setCurrentPath(path);
      setDirty(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="notepad-root">
      <div className="notepad-toolbar">
        <button className="notepad-toolbar-btn" onClick={handleSave}>
          {dirty ? "Stash *" : "Stash"}
        </button>
        <button className="notepad-toolbar-btn" onClick={handleSaveAs}>
          Save
        </button>
        <button className="notepad-toolbar-btn" onClick={handleOpen}>
          Open
        </button>
      </div>
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
