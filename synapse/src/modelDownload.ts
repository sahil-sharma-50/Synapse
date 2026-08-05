import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DownloadProgress {
  file: string;
  file_bytes_downloaded: number;
  file_bytes_total: number;
  overall_bytes_downloaded: number;
  overall_bytes_total: number;
}

/** "690 MB" / "1.2 GB" — sized units, because "0.7 GB" reads worse than "690 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Exported for unit tests; the hook is the only runtime caller. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.round(minutes / 60)} hr left`;
}

/**
 * Shared state machine for the 4-file model download, driven by the
 * `model-download-*` events the Rust side emits. Onboarding and Settings >
 * Voice both render it, so the transfer rate/ETA maths and the "did the
 * `invoke` itself get rejected" handling live here once rather than twice.
 */
export function useModelDownload() {
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(0);
  const sample = useRef<{ at: number; bytes: number } | null>(null);

  const refresh = useCallback(() => {
    invoke<boolean>("model_status")
      .then(setReady)
      .catch((e) => console.error("[synapse] model_status failed:", e));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const unlistenProgress = listen<DownloadProgress>("model-download-progress", (e) => {
      setProgress(e.payload);

      // Rate over a >=1s window rather than between adjacent chunks: 64KB
      // chunks arrive milliseconds apart, so a per-chunk rate swings wildly
      // and the ETA built on it is unreadable.
      const now = Date.now();
      const bytes = e.payload.overall_bytes_downloaded;
      const prev = sample.current;
      if (!prev || bytes < prev.bytes) {
        sample.current = { at: now, bytes };
      } else if (now - prev.at >= 1000) {
        setRate(((bytes - prev.bytes) * 1000) / (now - prev.at));
        sample.current = { at: now, bytes };
      }
    });
    const unlistenDone = listen("model-download-done", () => {
      setDownloading(false);
      setReady(true);
    });
    const unlistenError = listen<string>("model-download-error", (e) => {
      setDownloading(false);
      setError(e.payload);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  const start = useCallback(() => {
    setError("");
    setProgress(null);
    setRate(0);
    sample.current = null;
    setDownloading(true);
    invoke("download_model").catch((e) => {
      setDownloading(false);
      setError(String(e));
    });
  }, []);

  // A total of 0 means the size probe has not landed yet (the first progress
  // event can beat it); the bar renders indeterminate rather than snapping to
  // a fake 100% against a zero denominator.
  const total = progress?.overall_bytes_total ?? 0;
  const downloaded = progress?.overall_bytes_downloaded ?? 0;
  const known = total > 0;
  const percent = known ? Math.min(100, (100 * downloaded) / total) : 0;
  const remaining = known && rate > 0 ? formatEta((total - downloaded) / rate) : "";

  return {
    ready,
    downloading,
    progress,
    error,
    start,
    refresh,
    known,
    percent,
    downloaded,
    total,
    rate,
    remaining,
  };
}
