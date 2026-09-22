import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import WindowChrome from "./WindowChrome";
import { TrashIcon } from "./settings/icons";
import ContextMenu, { type ContextMenuState } from "./ContextMenu";
import SelectionBar from "./SelectionBar";
import { confirm } from "@tauri-apps/plugin-dialog";
import "./Clipboard.css";

type ClipKind = "text" | "link" | "image" | "files";
interface ClipEntry {
  id: string;
  text: string;
  kind: ClipKind;
  asset_path: string | null;
  file_paths: string[];
  byte_size: number;
  copied_at: number;
  pinned: boolean;
  name: string | null;
}

function relativeTime(ms: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 45) return "Now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function preview(entry: ClipEntry) {
  if (entry.kind === "image") return entry.name || "Copied image";
  if (entry.kind === "files") return entry.name || `${entry.file_paths.length} files`;
  return entry.text.replace(/\s+/g, " ").trim();
}

function kindLabel(kind: ClipKind) {
  return ({ text: "Text", link: "Link", image: "Image", files: "Files" } as const)[kind] ?? "Text";
}

const glyph = (path: string, filled = false) => (
  <svg className={filled ? "icon-filled" : undefined} viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
);

function ClipImage({ id }: { id: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let url = "";
    invoke<number[]>("clipboard_asset", { id })
      .then((bytes) => {
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/bmp" }));
        setSrc(url);
      })
      .catch(() => setSrc(""));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src ? (
    <img src={src} alt="Clipboard preview" />
  ) : (
    <span className="clip-image-placeholder">Image preview unavailable</span>
  );
}

export default function Clipboard() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [entries, setEntries] = useState<ClipEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ClipKind>("all");
  const [selected, setSelected] = useState(0);
  const [quickLook, setQuickLook] = useState<ClipEntry | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    Promise.all([invoke<ClipEntry[]>("list_clipboard"), invoke<Settings>("get_settings")])
      .then(([items, settings]) => {
        setEntries(items);
        setPaused(!settings.clipboard.history_enabled);
        setError("");
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    const changed = listen("clipboard-changed", refresh);
    const settings = listen("settings-changed", refresh);
    const focus = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) {
        refresh();
        searchRef.current?.focus();
      }
    });
    return () => {
      void changed.then((stop) => stop());
      void settings.then((stop) => stop());
      void focus.then((stop) => stop());
    };
  }, [refresh]);

  const ordered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => filter === "all" || entry.kind === filter)
      .filter(
        (entry) =>
          !needle ||
          `${entry.name ?? ""} ${entry.text} ${entry.file_paths.join(" ")}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.copied_at - a.copied_at);
  }, [entries, filter, query]);
  const active = Math.min(selected, Math.max(0, ordered.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function paste(entry: ClipEntry) {
    invoke("insert_clipboard_entry", { id: entry.id }).catch((reason) => setError(String(reason)));
  }
  function togglePin(entry: ClipEntry, event?: React.MouseEvent) {
    event?.stopPropagation();
    void invoke("pin_clipboard_entry", { id: entry.id, pinned: !entry.pinned })
      .then(refresh)
      .catch((reason) => setError(String(reason)));
  }
  function remove(entry: ClipEntry, event?: React.MouseEvent) {
    event?.stopPropagation();
    void invoke("delete_clipboard_entry", { id: entry.id })
      .then(refresh)
      .catch((reason) => setError(String(reason)));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      if (quickLook) setQuickLook(null);
      else void getCurrentWindow().hide();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if ((event.target as HTMLElement).closest("button, input[type=checkbox]")) return;
    if (event.key === " " && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      setQuickLook(ordered[active] ?? null);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((value) => Math.min(value + 1, ordered.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((value) => Math.max(value - 1, 0));
    }
    if (event.key === "Enter" && ordered[active]) {
      event.preventDefault();
      paste(ordered[active]);
    }
  }

  const selectedEntries = ordered.filter((entry) => checked.includes(entry.id));
  async function deleteSelected() {
    if (busy) return;
    setBusy(true);
    try {
      if (
        !(await confirm(`Delete ${selectedEntries.length} selected items from clipboard history?`, {
          title: "Delete clipboard items",
          kind: "warning",
        }))
      )
        return;
      for (const entry of selectedEntries) {
        await invoke("delete_clipboard_entry", { id: entry.id });
        setChecked((ids) => ids.filter((id) => id !== entry.id));
      }
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="clip-root" onKeyDown={onKeyDown}>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <WindowChrome
        title="Clipboard"
        subtitle={paused ? "Capture paused" : `${entries.length} items`}
        compact
      />
      <header className="clip-head sy-glass">
        <label className="clip-search-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m20 20-4.2-4.2m1.2-5.3a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
          </svg>
          <input
            ref={searchRef}
            className="clip-search"
            aria-label="Search clipboard history"
            placeholder="Search clipboard"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            autoFocus
          />
          <kbd>Ctrl K</kbd>
        </label>
        <div className="clip-filters" role="group" aria-label="Filter clipboard">
          {(["all", "text", "link", "image", "files"] as const).map((kind) => (
            <button
              key={kind}
              aria-pressed={filter === kind}
              className={filter === kind ? "clip-filter clip-filter-active" : "clip-filter"}
              onClick={() => {
                setChecked([]);
                setFilter(kind);
                setSelected(0);
              }}
            >
              {kind === "all" ? "All" : kindLabel(kind)}
            </button>
          ))}
        </div>
        {paused && (
          <button
            className="clip-paused"
            onClick={() => invoke("open_settings", { section: "clipboard" })}
          >
            <span /> Capture is paused · Open Settings
          </button>
        )}
      </header>

      <SelectionBar
        selected={selectedEntries.length}
        total={ordered.length}
        onSelectAll={(all) => setChecked(all ? ordered.map((entry) => entry.id) : [])}
      >
        <button disabled={busy} onClick={() => void deleteSelected()}>
          {busy ? "Deleting…" : "Delete selected"}
        </button>
      </SelectionBar>
      <div className="clip-list" ref={listRef}>
        {error && (
          <div className="utility-error" role="alert">
            <p>{error}</p>
            <button onClick={refresh}>Reload clipboard</button>
          </div>
        )}
        {!error && !ordered.length && (
          <div className="clip-empty">
            <span>⌘C</span>
            <h2>{entries.length ? "No matching items" : "Your clipboard is ready"}</h2>
            <p>
              {entries.length
                ? "Try another search or filter."
                : "Copy text, links, images, or files and they’ll appear here."}
            </p>
          </div>
        )}
        {ordered.map((entry, index) => (
          <article
            key={entry.id}
            onContextMenu={(event) => {
              event.preventDefault();
              setSelected(index);
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  {
                    text: "Paste",
                    icon: glyph("M9 5H5v16h14V5h-4M9 3h6v4H9zM9 12h6M9 16h6"),
                    action: () => paste(entry),
                  },
                  {
                    text: entry.pinned ? "Unpin" : "Pin",
                    icon: glyph("M6.5 4.5h11v16L12 17.4l-5.5 3.1z", entry.pinned),
                    action: () => togglePin(entry),
                  },
                  { text: "Delete from clipboard", danger: true, action: () => remove(entry) },
                ],
              });
            }}
            tabIndex={0}
            aria-label={preview(entry)}
            onFocus={() => setSelected(index)}
            className={index === active ? "clip-row clip-row-selected" : "clip-row"}
            data-selected={index === active}
            onMouseEnter={() => setSelected(index)}
            onClick={() => paste(entry)}
          >
            <input
              className="sy-item-checkbox"
              type="checkbox"
              aria-label={`Select ${preview(entry)}`}
              checked={checked.includes(entry.id)}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setChecked((ids) =>
                  event.target.checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id),
                )
              }
            />
            <div className={`clip-kind clip-kind-${entry.kind}`} aria-hidden="true">
              {entry.kind === "text"
                ? glyph("M5 5h14M12 5v14M8 19h8")
                : entry.kind === "link"
                  ? glyph(
                      "M10 13a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2",
                    )
                  : entry.kind === "image"
                    ? glyph("M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8h.01")
                    : glyph("M6 3h8l4 4v14H6zM14 3v5h5")}
            </div>
            <div className="clip-body">
              <div className="clip-preview">{preview(entry)}</div>
              <div className="clip-meta">
                <span>{kindLabel(entry.kind)}</span>
                <span>·</span>
                <time>{relativeTime(entry.copied_at)}</time>
                {entry.kind === "files" && (
                  <>
                    <span>·</span>
                    <span>
                      {entry.file_paths.length} {entry.file_paths.length === 1 ? "file" : "files"}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="clip-actions">
              <button
                className={entry.pinned ? "clip-icon-btn clip-icon-btn-on" : "clip-icon-btn"}
                onClick={(event) => togglePin(entry, event)}
                aria-label={entry.pinned ? "Unpin" : "Pin"}
                title={entry.pinned ? "Unpin" : "Pin"}
              >
                {glyph("M6.5 4.5h11v16L12 17.4l-5.5 3.1z", entry.pinned)}
              </button>
              <button
                className="clip-icon-btn clip-icon-btn-danger"
                onClick={(event) => remove(entry, event)}
                aria-label="Delete"
                title="Delete"
              >
                {<TrashIcon />}
              </button>
            </div>
          </article>
        ))}
      </div>

      <footer className="clip-foot">
        <span>
          <kbd>↑↓</kbd> Navigate
        </span>
        <span>
          <kbd>Enter</kbd> Paste
        </span>
        <span>
          <kbd>Space</kbd> Quick Look
        </span>
        <button
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            void invoke("clear_clipboard_history")
              .then(() => {
                setConfirmClear(false);
                refresh();
              })
              .catch((reason) => setError(String(reason)));
          }}
          disabled={!entries.some((entry) => !entry.pinned)}
        >
          {confirmClear ? "Clear unpinned?" : "Clear history"}
        </button>
        {confirmClear && <button onClick={() => setConfirmClear(false)}>Cancel</button>}
      </footer>

      {quickLook && (
        <div
          className="clip-quicklook"
          onClick={() => setQuickLook(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Clipboard preview"
        >
          <div className="clip-quicklook-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <span>{kindLabel(quickLook.kind)}</span>
              <button
                onClick={() => setQuickLook(null)}
                aria-label="Close preview"
                title="Close preview"
              >
                {glyph("M6 6l12 12M18 6 6 18")}
              </button>
            </header>
            {quickLook.kind === "image" ? (
              <ClipImage id={quickLook.id} />
            ) : quickLook.kind === "files" ? (
              <ul>
                {quickLook.file_paths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            ) : (
              <pre>{quickLook.text}</pre>
            )}
            <footer>
              <button onClick={() => paste(quickLook)}>Paste</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
