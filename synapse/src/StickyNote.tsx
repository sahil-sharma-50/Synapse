import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RichNoteEditor, { type RichNote } from "./RichNoteEditor";
import WindowChrome from "./WindowChrome";
import { NOTE_COLORS } from "./noteColors";
import "./StickyNote.css";

export default function StickyNote({ id }: { id: string }) {
  const [note, setNote] = useState<RichNote | null>(null);
  const [pickingColor, setPickingColor] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<RichNote>("get_note", { id }).then(setNote).catch((reason) => setError(String(reason)));
  }, [id]);

  async function chooseColor(color: string) {
    try {
      await invoke("set_note_color", { id, color });
      setNote((current) => current ? { ...current, color } : current);
      setPickingColor(false);
    } catch (reason) { setError(String(reason)); }
  }

  if (!note) return <div className="quick-note-loading">{error || "Opening quick note…"}</div>;

  return (
    <div className={`quick-note quick-note-${note.color}`}>
      <WindowChrome title="Quick Note" subtitle={note.content.split("\n").find(Boolean) || "New note"} compact close="close" />
      <div className="quick-note-actions">
        <button className="quick-note-color" onClick={() => setPickingColor((value) => !value)} aria-label="Change note color" title="Change note color"><span /></button>
        <button onClick={() => invoke("create_note", { color: note.color, quick: true })}>New Quick Note</button>
        <button onClick={() => invoke("open_notes_hub")}>Open in Notes</button>
      </div>
      {pickingColor && <div className="quick-note-palette" aria-label="Note colors">
        {NOTE_COLORS.map((color) => <button key={color.id} className={`quick-note-color-${color.id}${color.id === note.color ? " quick-note-color-active" : ""}`} onClick={() => void chooseColor(color.id)} aria-label={color.label} title={color.label} />)}
      </div>}
      {error && <div className="quick-note-error" role="alert">{error}</div>}
      <RichNoteEditor note={note} compact />
    </div>
  );
}
