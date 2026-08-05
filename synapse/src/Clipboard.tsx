import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./Clipboard.css";

interface ClipEntry {
  id: string;
  text: string;
  copied_at: number;
  pinned: boolean;
  name: string | null;
}

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(ms).toLocaleDateString();
}

/// Collapses a clip to one scannable line. Real clipboard content is full of
/// newlines and runs of spaces, which would otherwise render as a ragged gap.
function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

export default function Clipboard() {
  const [entries, setEntries] = useState<ClipEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    invoke<ClipEntry[]>("list_clipboard").then(setEntries).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  // The window is hidden rather than closed, so it must re-read on every show
  // and stay live while the user copies things in other apps.
  useEffect(() => {
    const unlistenChanged = listen("clipboard-changed", refresh);
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload) return;
      refresh();
      setConfirmingClear(false);
      searchRef.current?.focus();
      searchRef.current?.select();
    });
    return () => {
      unlistenChanged.then((f) => f());
      unlistenFocus.then((f) => f());
    };
  }, [refresh]);

  const { pinned, recent } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: ClipEntry) =>
      !q || e.text.toLowerCase().includes(q) || (e.name ?? "").toLowerCase().includes(q);
    const hits = entries.filter(match);
    return {
      pinned: hits.filter((e) => e.pinned),
      recent: hits.filter((e) => !e.pinned),
    };
  }, [entries, query]);

  // One flat ordering behind the two visual groups, so ↑/↓ crosses the
  // Pinned/Recent boundary the way the eye expects rather than trapping the
  // cursor in the first section.
  const ordered = useMemo(() => [...pinned, ...recent], [pinned, recent]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, ordered.length - 1)));
  }, [ordered.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function paste(entry: ClipEntry) {
    invoke("insert_clip", { content: entry.text });
  }

  function togglePin(entry: ClipEntry, e: React.MouseEvent) {
    e.stopPropagation();
    invoke("pin_clipboard_entry", { id: entry.id, pinned: !entry.pinned }).then(refresh);
  }

  function remove(entry: ClipEntry, e: React.MouseEvent) {
    e.stopPropagation();
    invoke("delete_clipboard_entry", { id: entry.id }).then(refresh);
  }

  function clearHistory() {
    invoke("clear_clipboard_history").then(() => {
      setConfirmingClear(false);
      refresh();
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (confirmingClear) {
        setConfirmingClear(false);
        return;
      }
      getCurrentWindow().hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, ordered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = ordered[selected];
      if (entry) paste(entry);
    }
  }

  function renderRow(entry: ClipEntry) {
    const index = ordered.indexOf(entry);
    const isSelected = index === selected;
    const lines = lineCount(entry.text);
    return (
      <div
        key={entry.id}
        className={`clip-row${isSelected ? " clip-row-selected" : ""}`}
        data-selected={isSelected}
        onClick={() => paste(entry)}
        onMouseEnter={() => setSelected(index)}
      >
        <div className="clip-body">
          {entry.name && <span className="clip-name">{entry.name}</span>}
          <span className="clip-preview">{preview(entry.text)}</span>
          <span className="clip-meta">
            {entry.pinned ? "Saved" : relativeTime(entry.copied_at)}
            {lines > 1 && ` · ${lines} lines`}
          </span>
        </div>
        <div className="clip-actions">
          <button
            className={`clip-icon-btn${entry.pinned ? " clip-icon-btn-on" : ""}`}
            onClick={(e) => togglePin(entry, e)}
            title={entry.pinned ? "Unpin" : "Pin to the top"}
            aria-label={entry.pinned ? "Unpin" : "Pin to the top"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6l-.7 5.2 3.2 3.1H13v7l-1 2-1-2v-7H6.5l3.2-3.1L9 3Z" />
            </svg>
          </button>
          <button
            className="clip-icon-btn clip-icon-btn-danger"
            onClick={(e) => remove(entry, e)}
            title="Delete"
            aria-label="Delete"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.1A1.5 1.5 0 0 0 8.8 19.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  const nothingAtAll = entries.length === 0;

  return (
    <div className="clip-root" onKeyDown={onKeyDown}>
      <header className="clip-head">
        <input
          ref={searchRef}
          className="clip-search"
          placeholder="Search everything you've copied…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          autoFocus
        />
      </header>

      <div className="clip-list" ref={listRef}>
        {nothingAtAll && (
          <div className="clip-empty">
            <p className="clip-empty-title">Nothing copied yet</p>
            <p className="clip-empty-body">
              Copy something anywhere on your machine and it will show up here. Pin the ones you
              reuse and they'll stay at the top.
            </p>
          </div>
        )}

        {!nothingAtAll && ordered.length === 0 && (
          <div className="clip-empty">
            <p className="clip-empty-title">No matches for "{query.trim()}"</p>
          </div>
        )}

        {pinned.length > 0 && <div className="clip-group">Pinned</div>}
        {pinned.map(renderRow)}

        {recent.length > 0 && <div className="clip-group">Recent</div>}
        {recent.map(renderRow)}
      </div>

      <footer className="clip-foot">
        <span className="clip-hint">↑↓ to move · enter to paste · esc to close</span>
        {/* Two-step, because this is unrecoverable. The label says exactly what
            survives, so nobody discovers afterwards that their pinned items
            were counted as "history". */}
        {confirmingClear ? (
          <span className="clip-confirm">
            <button className="clip-text-btn clip-text-btn-danger" onClick={clearHistory}>
              Delete {recent.length} item{recent.length === 1 ? "" : "s"}
            </button>
            <button className="clip-text-btn" onClick={() => setConfirmingClear(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            className="clip-text-btn"
            onClick={() => setConfirmingClear(true)}
            disabled={recent.length === 0}
          >
            Clear history
          </button>
        )}
      </footer>
    </div>
  );
}
