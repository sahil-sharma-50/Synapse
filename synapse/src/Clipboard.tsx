import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./models";
import WindowChrome from "./WindowChrome";
import "./Clipboard.css";

type ClipKind = "text" | "link" | "image" | "files";
interface ClipEntry { id: string; text: string; kind: ClipKind; asset_path: string | null; file_paths: string[]; byte_size: number; copied_at: number; pinned: boolean; name: string | null; }

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

function kindLabel(kind: ClipKind) { return ({ text: "Text", link: "Link", image: "Image", files: "Files" } as const)[kind] ?? "Text"; }

function ClipImage({ id }: { id: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let url = "";
    invoke<number[]>("clipboard_asset", { id }).then((bytes) => {
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/bmp" }));
      setSrc(url);
    }).catch(() => setSrc(""));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src ? <img src={src} alt="Clipboard preview" /> : <span className="clip-image-placeholder">Image preview unavailable</span>;
}

export default function Clipboard() {
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
      .then(([items, settings]) => { setEntries(items); setPaused(!settings.clipboard.history_enabled); setError(""); })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    const changed = listen("clipboard-changed", refresh);
    const settings = listen("settings-changed", refresh);
    const focus = getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) { refresh(); searchRef.current?.focus(); } });
    return () => { void changed.then((stop) => stop()); void settings.then((stop) => stop()); void focus.then((stop) => stop()); };
  }, [refresh]);

  const ordered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => filter === "all" || entry.kind === filter)
      .filter((entry) => !needle || `${entry.name ?? ""} ${entry.text} ${entry.file_paths.join(" ")}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.copied_at - a.copied_at);
  }, [entries, filter, query]);
  const active = Math.min(selected, Math.max(0, ordered.length - 1));

  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);

  function paste(entry: ClipEntry) { invoke("insert_clipboard_entry", { id: entry.id }).catch((reason) => setError(String(reason))); }
  function togglePin(entry: ClipEntry, event: React.MouseEvent) { event.stopPropagation(); void invoke("pin_clipboard_entry", { id: entry.id, pinned: !entry.pinned }).then(refresh); }
  function remove(entry: ClipEntry, event: React.MouseEvent) { event.stopPropagation(); void invoke("delete_clipboard_entry", { id: entry.id }).then(refresh); }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { if (quickLook) setQuickLook(null); else void getCurrentWindow().hide(); return; }
    if (event.key === " " && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); setQuickLook(ordered[active] ?? null); return; }
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, ordered.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(value - 1, 0)); }
    if (event.key === "Enter" && ordered[active]) { event.preventDefault(); paste(ordered[active]); }
  }

  return (
    <div className="clip-root" onKeyDown={onKeyDown}>
      <WindowChrome title="Clipboard" subtitle={paused ? "Capture paused" : `${entries.length} items`} compact />
      <header className="clip-head sy-glass">
        <label className="clip-search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 20-4.2-4.2m1.2-5.3a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" /></svg><input ref={searchRef} className="clip-search" aria-label="Search clipboard history" placeholder="Search clipboard" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} autoFocus /><kbd>Ctrl K</kbd></label>
        <div className="clip-filters" aria-label="Filter clipboard">
          {(["all", "text", "link", "image", "files"] as const).map((kind) => <button key={kind} className={filter === kind ? "clip-filter clip-filter-active" : "clip-filter"} onClick={() => { setFilter(kind); setSelected(0); }}>{kind === "all" ? "All" : kindLabel(kind)}</button>)}
        </div>
        {paused && <button className="clip-paused" onClick={() => invoke("open_settings", { section: "clipboard" })}><span /> Capture is paused · Open Settings</button>}
      </header>

      <div className="clip-list" ref={listRef}>
        {error && <div className="utility-error" role="alert"><p>{error}</p><button onClick={refresh}>Reload clipboard</button></div>}
        {!error && !ordered.length && <div className="clip-empty"><span>⌘C</span><h2>{entries.length ? "No matching items" : "Your clipboard is ready"}</h2><p>{entries.length ? "Try another search or filter." : "Copy text, links, images, or files and they’ll appear here."}</p></div>}
        {ordered.map((entry, index) => <article key={entry.id} className={index === active ? "clip-row clip-row-selected" : "clip-row"} data-selected={index === active} onMouseEnter={() => setSelected(index)} onClick={() => paste(entry)}>
          <div className={`clip-kind clip-kind-${entry.kind}`} aria-hidden="true">{entry.kind === "text" ? "T" : entry.kind === "link" ? "↗" : entry.kind === "image" ? "▧" : "⌑"}</div>
          <div className="clip-body"><div className="clip-preview">{preview(entry)}</div><div className="clip-meta"><span>{kindLabel(entry.kind)}</span><span>·</span><time>{relativeTime(entry.copied_at)}</time>{entry.kind === "files" && <><span>·</span><span>{entry.file_paths.length} {entry.file_paths.length === 1 ? "file" : "files"}</span></>}</div></div>
          <div className="clip-actions"><button className={entry.pinned ? "clip-icon-btn clip-icon-btn-on" : "clip-icon-btn"} onClick={(event) => togglePin(entry, event)} aria-label={entry.pinned ? "Unpin" : "Pin"}>{entry.pinned ? "★" : "☆"}</button><button className="clip-icon-btn clip-icon-btn-danger" onClick={(event) => remove(entry, event)} aria-label="Delete">×</button></div>
        </article>)}
      </div>

      <footer className="clip-foot"><span><kbd>↑↓</kbd> Navigate</span><span><kbd>Enter</kbd> Paste</span><span><kbd>Space</kbd> Quick Look</span><button onClick={() => invoke("clear_clipboard_history").then(refresh)} disabled={!entries.some((entry) => !entry.pinned)}>Clear</button></footer>

      {quickLook && <div className="clip-quicklook" onClick={() => setQuickLook(null)} role="dialog" aria-modal="true" aria-label="Clipboard preview"><div className="clip-quicklook-card" onClick={(event) => event.stopPropagation()}><header><span>{kindLabel(quickLook.kind)}</span><button onClick={() => setQuickLook(null)} aria-label="Close preview">×</button></header>{quickLook.kind === "image" ? <ClipImage id={quickLook.id} /> : quickLook.kind === "files" ? <ul>{quickLook.file_paths.map((path) => <li key={path}>{path}</li>)}</ul> : <pre>{quickLook.text}</pre>}<footer><button onClick={() => paste(quickLook)}>Paste</button></footer></div></div>}
    </div>
  );
}
