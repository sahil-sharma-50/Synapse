import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Notepad.css";

const SAVE_DEBOUNCE_MS = 500;

export default function Notepad() {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    invoke<string>("load_note").then((text) => {
      setContent(text);
      setLoaded(true);
    });
  }, []);

  // The debounce timer alone would lose the last ~500ms of edits if the user
  // closes the window right after typing — flush immediately on blur too.
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

  function onChange(text: string) {
    setContent(text);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke("save_note", { content: text });
    }, SAVE_DEBOUNCE_MS);
  }

  if (!loaded) return null;

  return (
    <div className="notepad-root">
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
