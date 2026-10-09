import { getCurrentWindow } from "@tauri-apps/api/window";
import "./WindowChrome.css";

type WindowChromeProps = {
  title: string;
  subtitle?: string;
  compact?: boolean;
  close?: "hide" | "close";
};

export default function WindowChrome({
  title,
  subtitle,
  compact = false,
  close = "hide",
}: WindowChromeProps) {
  const window = getCurrentWindow();

  return (
    <header
      className={`window-chrome${compact ? " window-chrome-compact" : ""}`}
      data-tauri-drag-region
    >
      <div className="window-chrome-title" data-tauri-drag-region>
        <span>{title}</span>
        {subtitle && <small>{subtitle}</small>}
      </div>
      <div className="window-chrome-actions">
        <button aria-label="Minimize" title="Minimize" onClick={() => window.minimize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8" /></svg>
        </button>
        <button aria-label="Maximize" title="Maximize" onClick={() => window.toggleMaximize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx=".5" /></svg>
        </button>
        <button
          className="window-chrome-close"
          aria-label="Close"
          title="Close"
          onClick={() => (close === "close" ? window.close() : window.hide())}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg>
        </button>
      </div>
    </header>
  );
}
