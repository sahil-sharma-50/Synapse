import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TtsSetupProgress {
  stage: "python" | "packages" | "weights";
  bytes_downloaded: number;
  bytes_total: number;
}

const STAGE_LABELS: Record<TtsSetupProgress["stage"], string> = {
  python: "Downloading Python runtime…",
  packages: "Installing packages…",
  weights: "Downloading voice model…",
};

/**
 * State machine for the pocket-tts engine setup, mirroring
 * `useModelDownload()`'s shape but stage-aware: unlike the flat ASR file
 * list, setup here has qualitatively different stages (runtime download,
 * pip install, weight prewarm) so a single blended byte counter would be
 * misleading — this exposes a stage label instead of a byte total.
 */
export function useTtsSetup() {
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [stage, setStage] = useState<TtsSetupProgress["stage"] | null>(null);
  // Only the `python` stage reports real byte totals; `packages` and
  // `weights` emit 0/0 because pip and the prewarm sidecar give us no
  // countable progress. `known` below is what callers use to decide between
  // a percentage meter and an indeterminate one.
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    invoke<boolean>("tts_setup_status")
      .then(setReady)
      .catch((e) => console.error("[synapse] tts_setup_status failed:", e));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const unlistenProgress = listen<TtsSetupProgress>("tts-setup-progress", (e) => {
      setStage(e.payload.stage);
      setDownloaded(e.payload.bytes_downloaded);
      setTotal(e.payload.bytes_total);
    });
    const unlistenDone = listen("tts-setup-done", () => {
      setDownloading(false);
      setReady(true);
      setStage(null);
      setDownloaded(0);
      setTotal(0);
    });
    const unlistenError = listen<string>("tts-setup-error", (e) => {
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
    setStage(null);
    setDownloaded(0);
    setTotal(0);
    setDownloading(true);
    invoke("download_tts_engine").catch((e) => {
      setDownloading(false);
      setError(String(e));
    });
  }, []);

  const known = total > 0;

  return {
    ready,
    downloading,
    stage,
    stageLabel: stage ? STAGE_LABELS[stage] : "",
    downloaded,
    total,
    known,
    percent: known ? Math.min(100, (downloaded / total) * 100) : 0,
    error,
    start,
    refresh,
  };
}
