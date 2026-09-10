import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import RichNoteEditor, { type RichNote } from "./RichNoteEditor";
import WindowChrome from "./WindowChrome";
import "./NotesHub.css";

interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  color: string;
  open: boolean;
  updated_at: number;
  favorite: boolean;
  folder: string | null;
  tags: string[];
  trashed_at: number | null;
}

type Filter = "notes" | "favorites" | "trash" | `folder:${string}`;

function relativeTime(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const glyph = (path: string) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;

export default function NotesHub() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<RichNote | null>(null);
  const [filter, setFilter] = useState<Filter>("notes");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    invoke<NoteSummary[]>("list_notes")
      .then((items) => { setNotes(Array.isArray(items) ? items : []); setError(""); })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    const changed = listen("notes-changed", refresh);
    const focus = getCurrentWindow().onFocusChanged(({ payload }) => payload && refresh());
    return () => { void changed.then((stop) => stop()); void focus.then((stop) => stop()); };
  }, [refresh]);

  const folders = useMemo(() => [...new Set(notes.map((note) => note.folder).filter((value): value is string => Boolean(value)))].sort(), [notes]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes
      .filter((note) => {
        if (filter === "trash") return note.trashed_at !== null;
        if (note.trashed_at !== null) return false;
        if (filter === "favorites" && !note.favorite) return false;
        if (filter.startsWith("folder:") && note.folder !== filter.slice(7)) return false;
        return !needle || `${note.title} ${note.preview} ${note.tags.join(" ")}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => b.updated_at - a.updated_at);
  }, [filter, notes, query]);
  const activeSelectedId = visible.some((note) => note.id === selectedId) ? selectedId : visible[0]?.id ?? null;

  useEffect(() => {
    if (!activeSelectedId) return;
    invoke<RichNote>("get_note", { id: activeSelectedId }).then(setSelectedNote).catch((reason) => setError(String(reason)));
  }, [activeSelectedId]);

  async function createNote(quick = false) {
    try {
      const id = await invoke<string>("create_note", { quick });
      refresh();
      if (!quick) { setFilter("notes"); setSelectedId(id); }
    } catch (reason) { setError(String(reason)); }
  }

  function setFavorite(note: NoteSummary, event: React.MouseEvent) {
    event.stopPropagation();
    void invoke("favorite_note", { id: note.id, favorite: !note.favorite }).then(refresh);
  }

  function setTrashed(note: NoteSummary, trashed: boolean, event: React.MouseEvent) {
    event.stopPropagation();
    void invoke("trash_note", { id: note.id, trashed }).then(refresh);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") void getCurrentWindow().hide();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); void createNote(); }
  }

  return (
    <div className="hub-root" onKeyDown={onKeyDown}>
      <WindowChrome title="Notes" subtitle={selectedNote?.content.split("\n").find(Boolean) || "Synapse"} />
      <div className="hub-workspace">
        <nav className="hub-sidebar sy-glass" aria-label="Notes navigation">
          <div className="hub-sidebar-head"><span>Notes</span><button onClick={() => void createNote()} aria-label="New note" title="New note">{glyph("M12 5v14M5 12h14")}</button></div>
          <button className={filter === "notes" ? "hub-nav hub-nav-active" : "hub-nav"} onClick={() => setFilter("notes")}>{glyph("M5 4h14v16H5zM8 8h8M8 12h8M8 16h5")}<span>All Notes</span><b>{notes.filter((n) => !n.trashed_at).length}</b></button>
          <button className={filter === "favorites" ? "hub-nav hub-nav-active" : "hub-nav"} onClick={() => setFilter("favorites")}>{glyph("m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z")}<span>Favorites</span><b>{notes.filter((n) => n.favorite && !n.trashed_at).length}</b></button>
          <button className={filter === "trash" ? "hub-nav hub-nav-active" : "hub-nav"} onClick={() => setFilter("trash")}>{glyph("M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13")}<span>Recently Deleted</span></button>
          <div className="hub-nav-label">Folders</div>
          {folders.map((folder) => <button key={folder} className={filter === `folder:${folder}` ? "hub-nav hub-nav-active" : "hub-nav"} onClick={() => setFilter(`folder:${folder}`)}>{glyph("M3 6h7l2 2h9v10H3z")}<span>{folder}</span></button>)}
          {!folders.length && <p className="hub-sidebar-empty">Add a folder name inside any note.</p>}
          <button className="hub-quick" onClick={() => void createNote(true)}>{glyph("M12 3v18M3 12h18")}<span>New Quick Note</span></button>
        </nav>

        <section className="hub-list-pane" aria-label="Note list">
          <div className="hub-list-head">
            <label className="hub-search-wrap">{glyph("m20 20-4.2-4.2m1.2-5.3a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z")}<input className="hub-search" aria-label="Search notes" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <span>{visible.length} {visible.length === 1 ? "Note" : "Notes"}</span>
          </div>
          <div className="hub-list">
            {error && <div className="utility-error" role="alert"><p>{error}</p><button onClick={refresh}>Reload notes</button></div>}
            {!error && !visible.length && <div className="hub-empty"><span>{glyph("M6 3h9l4 4v14H6zM15 3v5h5")}</span><h2>{filter === "trash" ? "No deleted notes" : "A quiet place for your ideas"}</h2><p>{filter === "trash" ? "Notes you delete will wait here." : "Create a note and start writing."}</p><button onClick={() => void createNote()}>New Note</button></div>}
            {visible.map((note) => <article key={note.id} className={activeSelectedId === note.id ? "hub-item hub-item-selected" : "hub-item"} onClick={() => setSelectedId(note.id)}>
              <div className="hub-item-top"><h3>{note.title}</h3><time>{relativeTime(note.updated_at)}</time></div>
              <p>{note.preview || "No additional text"}</p>
              <div className="hub-item-foot"><span>{note.folder || "Notes"}</span>{note.tags.slice(0, 2).map((tag) => <em key={tag}>#{tag}</em>)}<span className="hub-item-actions"><button onClick={(event) => setFavorite(note, event)} aria-label={note.favorite ? "Remove favorite" : "Favorite"}>{note.favorite ? "★" : "☆"}</button><button onClick={(event) => setTrashed(note, filter !== "trash", event)} aria-label={filter === "trash" ? "Restore note" : "Move to recently deleted"}>{filter === "trash" ? "↩" : "⌫"}</button></span></div>
            </article>)}
          </div>
        </section>

        <main className="hub-editor-pane">
          {activeSelectedId && selectedNote?.id === activeSelectedId ? <RichNoteEditor key={selectedNote.id} note={selectedNote} onChanged={refresh} /> : <div className="hub-editor-empty">Select a note to begin.</div>}
        </main>
      </div>
    </div>
  );
}
