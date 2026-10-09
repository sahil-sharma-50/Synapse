import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import RichNoteEditor, { type RichNote } from "./RichNoteEditor";
import WindowChrome from "./WindowChrome";
import { TrashIcon } from "./settings/icons";
import { confirm } from "@tauri-apps/plugin-dialog";
import ContextMenu, { type ContextMenuState } from "./ContextMenu";
import SelectionBar from "./SelectionBar";
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
  return days < 7
    ? `${days}d`
    : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const glyph = (path: string, filled = false) => (
  <svg className={filled ? "icon-filled" : undefined} viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
);

export default function NotesHub() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<RichNote | null>(null);
  const [filter, setFilter] = useState<Filter>("notes");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    invoke<NoteSummary[]>("list_notes")
      .then((items) => {
        setNotes(Array.isArray(items) ? items : []);
        setError("");
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    const changed = listen("notes-changed", refresh);
    const focus = getCurrentWindow().onFocusChanged(({ payload }) => payload && refresh());
    return () => {
      void changed.then((stop) => stop());
      void focus.then((stop) => stop());
    };
  }, [refresh]);

  const folders = useMemo(
    () =>
      [
        ...new Set(
          notes
            .filter((note) => note.trashed_at === null)
            .map((note) => note.folder)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort(),
    [notes],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes
      .filter((note) => {
        if (filter === "trash") return note.trashed_at !== null;
        if (note.trashed_at !== null) return false;
        if (filter === "favorites" && !note.favorite) return false;
        if (filter.startsWith("folder:") && note.folder !== filter.slice(7)) return false;
        return (
          !needle ||
          `${note.title} ${note.preview} ${note.tags.join(" ")}`.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => b.updated_at - a.updated_at);
  }, [filter, notes, query]);
  const activeSelectedId = visible.some((note) => note.id === selectedId)
    ? selectedId
    : (visible[0]?.id ?? null);

  useEffect(() => {
    if (!activeSelectedId) return;
    invoke<RichNote>("get_note", { id: activeSelectedId })
      .then(setSelectedNote)
      .catch((reason) => setError(String(reason)));
  }, [activeSelectedId]);

  async function createNote(quick = false) {
    try {
      const id = await invoke<string>("create_note", { quick });
      refresh();
      if (!quick) {
        setFilter("notes");
        setSelectedId(id);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  function setFavorite(note: NoteSummary, event?: React.MouseEvent) {
    event?.stopPropagation();
    void invoke("favorite_note", { id: note.id, favorite: !note.favorite })
      .then(refresh)
      .catch((reason) => setError(String(reason)));
  }

  function setTrashed(note: NoteSummary, trashed: boolean, event?: React.MouseEvent) {
    event?.stopPropagation();
    void invoke("trash_note", { id: note.id, trashed })
      .then(refresh)
      .catch((reason) => setError(String(reason)));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") void getCurrentWindow().hide();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      void createNote();
    }
  }

  function noteMenu(event: React.MouseEvent, note: NoteSummary) {
    event.preventDefault();
    setSelectedId(note.id);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          text: note.favorite ? "Remove favorite" : "Favorite",
          icon: glyph(
            "m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
            note.favorite,
          ),
          action: () => setFavorite(note),
        },
        {
          text: note.trashed_at === null ? "Delete note" : "Restore note",
          danger: note.trashed_at === null,
          icon: note.trashed_at !== null ? glyph("M9 7H5V3M5 7a8 8 0 1 1-1 8") : undefined,
          action: () => setTrashed(note, note.trashed_at === null),
        },
        ...(note.trashed_at === null
          ? []
          : [
              {
                text: "Delete permanently…",
                danger: true,
                action: () => {
                  void confirm(`Permanently delete “${note.title}”? This cannot be undone.`, {
                    title: "Delete note",
                    kind: "warning",
                  })
                    .then((approved) =>
                      approved ? invoke("delete_note", { id: note.id }).then(refresh) : undefined,
                    )
                    .catch((reason) => setError(String(reason)));
                },
              },
            ]),
      ],
    });
  }

  function folderMenu(event: React.MouseEvent, folder: string) {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          text: "Delete folder and notes…",
          danger: true,
          action: () => {
            void confirm(
              `Delete “${folder}” and move its notes to Recently Deleted? You can restore the notes there.`,
              { title: "Delete folder", kind: "warning" },
            )
              .then(async (approved) => {
                if (!approved) return;
                await invoke("trash_note_folder", { folder });
                if (filter === `folder:${folder}`) setFilter("notes");
                refresh();
              })
              .catch((reason) => setError(String(reason)));
          },
        },
      ],
    });
  }

  const selectedNotes = visible.filter((note) => checked.includes(note.id));
  async function bulkNotes(restore = false) {
    if (busy) return;
    setBusy(true);
    try {
      if (
        filter === "trash" &&
        !restore &&
        !(await confirm(
          `Permanently delete ${selectedNotes.length} notes? This cannot be undone.`,
          { title: "Delete notes", kind: "warning" },
        ))
      )
        return;
      for (const note of selectedNotes) {
        await invoke(filter === "trash" && !restore ? "delete_note" : "trash_note", {
          id: note.id,
          trashed: !restore,
        });
        setChecked((ids) => ids.filter((id) => id !== note.id));
      }
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hub-root" onKeyDown={onKeyDown}>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <WindowChrome
        title="Notes"
        subtitle={selectedNote?.content.split("\n").find(Boolean) || "Synapse"}
      />
      <div className="hub-workspace">
        <nav className="hub-sidebar sy-glass" aria-label="Notes navigation">
          <div className="hub-sidebar-head">
            <span>Notes</span>
            <button onClick={() => void createNote()} aria-label="New note" title="New note">
              {glyph("M12 5v14M5 12h14")}
            </button>
          </div>
          <button
            className={filter === "notes" ? "hub-nav hub-nav-active" : "hub-nav"}
            onClick={() => {
              setChecked([]);
              setFilter("notes");
            }}
          >
            {glyph("M5 4h14v16H5zM8 8h8M8 12h8M8 16h5")}
            <span>All Notes</span>
            <b>{notes.filter((n) => !n.trashed_at).length}</b>
          </button>
          <button
            className={filter === "favorites" ? "hub-nav hub-nav-active" : "hub-nav"}
            onClick={() => {
              setChecked([]);
              setFilter("favorites");
            }}
          >
            {glyph("m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z")}
            <span>Favorites</span>
            <b>{notes.filter((n) => n.favorite && !n.trashed_at).length}</b>
          </button>
          <button
            className={filter === "trash" ? "hub-nav hub-nav-active" : "hub-nav"}
            onClick={() => {
              setChecked([]);
              setFilter("trash");
            }}
          >
            {glyph("M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13")}
            <span>Recently Deleted</span>
          </button>
          <div className="hub-nav-label">Folders</div>
          {folders.map((folder) => (
            <button
              key={folder}
              title={folder}
              aria-label={folder}
              onContextMenu={(event) => folderMenu(event, folder)}
              className={filter === `folder:${folder}` ? "hub-nav hub-nav-active" : "hub-nav"}
              onClick={() => {
                setChecked([]);
                setFilter(`folder:${folder}`);
              }}
            >
              {glyph("M3 6h7l2 2h9v10H3z")}
              <span>{folder}</span>
            </button>
          ))}
          {!folders.length && (
            <p className="hub-sidebar-empty">Add a folder name inside any note.</p>
          )}
          <button className="hub-quick" onClick={() => void createNote(true)}>
            {glyph("M12 3v18M3 12h18")}
            <span>New Quick Note</span>
          </button>
        </nav>

        <section className="hub-list-pane" aria-label="Note list">
          <div className="hub-list-head">
            <label className="hub-search-wrap">
              {glyph("m20 20-4.2-4.2m1.2-5.3a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z")}
              <input
                className="hub-search"
                aria-label="Search notes"
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span>
              {visible.length} {visible.length === 1 ? "Note" : "Notes"}
            </span>
          </div>
          <SelectionBar
            selected={selectedNotes.length}
            total={visible.length}
            onSelectAll={(all) => setChecked(all ? visible.map((note) => note.id) : [])}
          >
            {filter === "trash" && (
              <button disabled={busy} onClick={() => void bulkNotes(true)}>
                Restore
              </button>
            )}
            <button disabled={busy} onClick={() => void bulkNotes()}>
              {busy ? "Working…" : filter === "trash" ? "Delete forever" : "Delete"}
            </button>
          </SelectionBar>
          <div className="hub-list">
            {error && (
              <div className="utility-error" role="alert">
                <p>{error}</p>
                <button onClick={refresh}>Reload notes</button>
              </div>
            )}
            {!error && !visible.length && (
              <div className="hub-empty">
                <span>{glyph("M6 3h9l4 4v14H6zM15 3v5h5")}</span>
                <h2>{filter === "trash" ? "No deleted notes" : "A quiet place for your ideas"}</h2>
                <p>
                  {filter === "trash"
                    ? "Notes you delete will wait here."
                    : "Create a note and start writing."}
                </p>
                <button onClick={() => void createNote()}>New Note</button>
              </div>
            )}
            {visible.map((note) => (
              <article
                key={note.id}
                onContextMenu={(event) => noteMenu(event, note)}
                tabIndex={0}
                aria-label={note.title}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    setSelectedId(note.id);
                  }
                }}
                className={activeSelectedId === note.id ? "hub-item hub-item-selected" : "hub-item"}
                onClick={() => setSelectedId(note.id)}
              >
                <div className="hub-item-top">
                  <input
                    className="sy-item-checkbox"
                    type="checkbox"
                    aria-label={`Select ${note.title}`}
                    checked={checked.includes(note.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setChecked((ids) =>
                        event.target.checked
                          ? [...ids, note.id]
                          : ids.filter((id) => id !== note.id),
                      )
                    }
                  />
                  <h3>{note.title}</h3>
                  <time>{relativeTime(note.updated_at)}</time>
                </div>
                <p>{note.preview || "No additional text"}</p>
                <div className="hub-item-foot">
                  <span>{note.folder || "Notes"}</span>
                  {note.tags.slice(0, 2).map((tag) => (
                    <em key={tag}>#{tag}</em>
                  ))}
                  <span className="hub-item-actions">
                    <button
                      onClick={(event) => setFavorite(note, event)}
                      aria-label={note.favorite ? "Remove favorite" : "Favorite"}
                      title={note.favorite ? "Remove favorite" : "Favorite"}
                    >
                      {glyph("M6.5 4.5h11v16L12 17.4l-5.5 3.1z", note.favorite)}
                    </button>
                    <button
                      className="hub-item-delete"
                      onClick={(event) => setTrashed(note, filter !== "trash", event)}
                      aria-label={filter === "trash" ? "Restore note" : "Move to recently deleted"}
                      title={filter === "trash" ? "Restore note" : "Move to recently deleted"}
                    >
                      {filter === "trash" ? glyph("M9 7H5V3M5 7a8 8 0 1 1-1 8") : <TrashIcon />}
                    </button>
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>

        <main className="hub-editor-pane">
          {activeSelectedId && selectedNote?.id === activeSelectedId ? (
            <RichNoteEditor key={selectedNote.id} note={selectedNote} onChanged={refresh} />
          ) : (
            <div className="hub-editor-empty">Select a note to begin.</div>
          )}
        </main>
      </div>
    </div>
  );
}
