import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./NotesHub.css";

interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  color: string;
  open: boolean;
  updated_at: number;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(ms).toLocaleDateString();
}

/// The list of every sticky note. Clicking one pops its own window out onto
/// the desktop; this window is the index, not an editor.
export default function NotesHub() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<NoteSummary[]>("list_notes").then(setNotes).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  // Hidden rather than closed, and the notes themselves are edited in other
  // windows — so this list has to follow along live.
  useEffect(() => {
    const unlistenChanged = listen("notes-changed", refresh);
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) {
        refresh();
        setConfirmingDelete(null);
      }
    });
    return () => {
      unlistenChanged.then((f) => f());
      unlistenFocus.then((f) => f());
    };
  }, [refresh]);

  function open(id: string) {
    invoke("open_note_window", { id });
  }

  function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    invoke("delete_note", { id }).then(() => {
      setConfirmingDelete(null);
      refresh();
    });
  }

  return (
    <div
      className="hub-root"
      onKeyDown={(e) => {
        if (e.key === "Escape") getCurrentWindow().hide();
      }}
    >
      <header className="hub-head">
        <h1 className="hub-title">Notes</h1>
        <button className="hub-new" onClick={() => invoke("create_note", {})}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 6v12M6 12h12" />
          </svg>
          New note
        </button>
      </header>

      <div className="hub-list">
        {notes.length === 0 && (
          <div className="hub-empty">
            <p className="hub-empty-title">No notes yet</p>
            <p className="hub-empty-body">
              Every note gets its own small window you can park anywhere on screen. They stay on
              top and come back where you left them.
            </p>
          </div>
        )}

        {notes.map((note) => (
          <div
            key={note.id}
            className={`hub-item hub-item-${note.color}`}
            onClick={() => open(note.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open(note.id);
              }
            }}
          >
            <div className="hub-item-body">
              <span className="hub-item-title">{note.title}</span>
              {note.preview && <span className="hub-item-preview">{note.preview}</span>}
              <span className="hub-item-meta">
                {note.open && <span className="hub-open-dot" aria-hidden="true" />}
                {note.open ? "On screen" : relativeTime(note.updated_at)}
              </span>
            </div>

            {/* Two-step delete: a note is real work, and there is no undo. */}
            {confirmingDelete === note.id ? (
              <div className="hub-item-actions" onClick={(e) => e.stopPropagation()}>
                <button className="hub-text-btn hub-text-btn-danger" onClick={(e) => remove(note.id, e)}>
                  Delete
                </button>
                <button className="hub-text-btn" onClick={() => setConfirmingDelete(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="hub-item-actions">
                <button
                  className="hub-icon-btn"
                  title="Delete note"
                  aria-label="Delete note"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingDelete(note.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.1A1.5 1.5 0 0 0 8.8 19.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
