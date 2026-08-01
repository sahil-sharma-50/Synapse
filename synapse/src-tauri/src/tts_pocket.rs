use serde::{Deserialize, Serialize};

#[derive(Serialize, Debug, PartialEq)]
pub struct SidecarRequest {
    pub id: u64,
    pub text: String,
    pub voice: String,
    pub out_path: String,
}

#[derive(Deserialize, Debug, PartialEq)]
pub struct SidecarResponse {
    pub id: u64,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

/// One JSON object per line on the sidecar's stdin — no trailing newline
/// baked in, the caller writing to the child process appends it.
pub fn encode_request(req: &SidecarRequest) -> String {
    serde_json::to_string(req).expect("SidecarRequest always serializes")
}

pub fn decode_response(line: &str) -> Result<SidecarResponse, String> {
    serde_json::from_str(line).map_err(|e| format!("bad sidecar response: {e}"))
}

/// True when `response_id` answers the most recently sent request. A `false`
/// means the response was superseded by a newer speak request while the
/// sidecar was still working — the caller should discard it (and delete its
/// temp WAV) instead of playing stale audio.
pub fn is_current(response_id: u64, generation: u64) -> bool {
    response_id == generation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_request_as_single_line_json() {
        let req = SidecarRequest {
            id: 1,
            text: "hello".to_string(),
            voice: "alba".to_string(),
            out_path: "C:\\tmp\\tts_1.wav".to_string(),
        };
        let line = encode_request(&req);
        assert!(!line.contains('\n'), "request must be a single line");
        assert!(line.contains("\"id\":1"));
        assert!(line.contains("\"voice\":\"alba\""));
    }

    #[test]
    fn decodes_ok_response() {
        let response = decode_response(r#"{"id":2,"status":"ok"}"#).expect("valid response");
        assert_eq!(response.id, 2);
        assert_eq!(response.status, "ok");
        assert_eq!(response.message, None);
    }

    #[test]
    fn decodes_error_response_with_message() {
        let response =
            decode_response(r#"{"id":3,"status":"error","message":"boom"}"#).expect("valid response");
        assert_eq!(response.status, "error");
        assert_eq!(response.message, Some("boom".to_string()));
    }

    #[test]
    fn rejects_malformed_response() {
        assert!(decode_response("not json").is_err());
    }

    #[test]
    fn current_response_matches_latest_generation() {
        assert!(is_current(5, 5));
    }

    #[test]
    fn stale_response_does_not_match_newer_generation() {
        assert!(!is_current(4, 5), "a response to an older request must not be treated as current");
    }
}

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    // `Option` so a read can be handed off to a dedicated timeout-guarding
    // thread (via `.take()`) and returned afterward — see `speak()`'s
    // `write_and_read` closure.
    stdout: Option<BufReader<ChildStdout>>,
}

/// `rodio::OutputStream` wraps a platform audio handle (`cpal::Stream`) that
/// is `!Send` on every backend (it carries a raw pointer marker so it can
/// never be sent to, or accessed from, more than one thread at a time by
/// the type system's own rules) — on Windows the underlying WASAPI/COM audio
/// handles have thread affinity, so even *dropping* one on a different
/// thread than it was created on is unsound.
///
/// Instead of asserting `Send` on the stream, playback lives entirely on one
/// dedicated background thread spawned once in `TtsSidecar::default()`. That
/// thread owns creation, playback, and drop of the `OutputStream`/`Sink` as
/// plain local variables — nothing audio-related ever crosses a thread
/// boundary as a value. `speak()` (which may run on any Tauri worker thread)
/// only ever sends a `PlaybackCommand` describing *what* to play down an
/// `mpsc` channel; the dedicated thread does the actual playing.
enum PlaybackCommand {
    Play(std::path::PathBuf),
    Stop,
}

/// Owns the long-lived Python sidecar and a channel to the dedicated audio
/// playback thread. One instance lives in Tauri's managed state for the
/// app's lifetime.
pub struct TtsSidecar {
    process: Mutex<Option<SidecarProcess>>,
    audio_tx: std::sync::mpsc::Sender<PlaybackCommand>,
    generation: AtomicU64,
}

impl Default for TtsSidecar {
    fn default() -> Self {
        let (audio_tx, audio_rx) = std::sync::mpsc::channel::<PlaybackCommand>();

        // The one and only thread that ever touches OutputStream/Sink. Both
        // are kept as local variables here — never stored in shared state —
        // so creation, playback, and drop all happen on this same thread.
        std::thread::spawn(move || {
            let mut current: Option<(rodio::OutputStream, rodio::Sink)> = None;
            for cmd in audio_rx {
                match cmd {
                    PlaybackCommand::Stop => {
                        // Dropping the taken value here stops playback and
                        // tears down the OutputStream, both on this thread.
                        drop(current.take());
                    }
                    PlaybackCommand::Play(path) => {
                        // Drop any previous stream/sink before creating the
                        // new one — still on this thread.
                        drop(current.take());
                        let played = (|| -> Result<(rodio::OutputStream, rodio::Sink), String> {
                            let (stream, handle) =
                                rodio::OutputStream::try_default().map_err(|e| e.to_string())?;
                            let sink = rodio::Sink::try_new(&handle).map_err(|e| e.to_string())?;
                            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                            let source = rodio::Decoder::new(std::io::BufReader::new(file))
                                .map_err(|e| e.to_string())?;
                            sink.append(source);
                            Ok((stream, sink))
                        })();
                        if let Ok(pair) = played {
                            current = Some(pair);
                        } else if let Err(e) = played {
                            eprintln!("tts playback failed: {e}");
                        }
                    }
                }
            }
        });

        Self {
            process: Mutex::new(None),
            audio_tx,
            generation: AtomicU64::new(0),
        }
    }
}

impl TtsSidecar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Best-effort kill of the cached sidecar process, if one is running.
    /// Called on app exit — `Child::drop` does not kill the child process,
    /// and Windows won't reap an orphaned `python.exe` on its own, so
    /// without this the sidecar (holding a loaded, possibly multi-GB TTS
    /// model) would keep running in the background after Synapse quits.
    pub fn kill(&self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut proc) = guard.take() {
                let _ = proc.child.kill();
            }
        }
    }

    fn ensure_process(
        &self,
        python_path: &std::path::Path,
        sidecar_path: &std::path::Path,
    ) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|_| "sidecar lock poisoned")?;
        if guard.is_some() {
            return Ok(());
        }
        let mut cmd = Command::new(python_path);
        cmd.arg(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // python.exe is a console-subsystem binary; spawned from a GUI app
        // with no console of its own, Windows would otherwise flash a new
        // console window on screen for the lifetime of the sidecar.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to start tts sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        *guard = Some(SidecarProcess { child, stdin, stdout: Some(BufReader::new(stdout)) });
        Ok(())
    }

    /// Stops any currently-playing audio, bumps the request generation, sends
    /// a new request to the (lazily spawned) sidecar, and plays the result.
    /// A dead sidecar (write/read failure) clears the cached process so the
    /// next call respawns it, and is surfaced as an `Err` for the caller to
    /// fall back to OS-native TTS.
    pub fn speak(
        &self,
        python_path: &std::path::Path,
        sidecar_path: &std::path::Path,
        text: &str,
        voice: &str,
        out_dir: &std::path::Path,
    ) -> Result<(), String> {
        // Stop any currently-playing audio. The actual `Sink`/`OutputStream`
        // teardown happens on the dedicated audio thread, not here.
        let _ = self.audio_tx.send(PlaybackCommand::Stop);

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.ensure_process(python_path, sidecar_path)?;

        let out_path = out_dir.join(format!("tts_{generation}.wav"));
        let request = SidecarRequest {
            id: generation,
            text: text.to_string(),
            voice: voice.to_string(),
            out_path: out_path.to_string_lossy().to_string(),
        };

        // `read_line` below has no built-in timeout. If the Python process
        // hangs (stuck model load, deadlock, etc.) a plain blocking read
        // would never return — and because it runs while `self.process` is
        // locked, every future `speak()` call would wedge on the same mutex
        // for the rest of the session. To bound the wait, the actual read
        // happens on its own thread and this closure waits on it with
        // `recv_timeout`; a timeout is treated as a failure like any other
        // `write_and_read` error, which clears the cached process below so
        // the next call respawns a fresh sidecar instead of staying stuck.
        const SIDECAR_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
        let write_and_read = || -> Result<SidecarResponse, String> {
            let mut guard = self.process.lock().map_err(|_| "sidecar lock poisoned")?;
            let proc = guard.as_mut().ok_or("sidecar not running")?;
            writeln!(proc.stdin, "{}", encode_request(&request)).map_err(|e| e.to_string())?;

            // `BufReader<ChildStdout>` can't be read from two threads at
            // once, so temporarily hand ownership of just the stdout buffer
            // to the reader thread (via `.take()`) and reclaim it afterward.
            let mut stdout = proc.stdout.take().ok_or("sidecar stdout unavailable")?;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = stdout.read_line(&mut line).map_err(|e| e.to_string());
                let _ = tx.send((stdout, result, line));
            });

            match rx.recv_timeout(SIDECAR_READ_TIMEOUT) {
                Ok((stdout, result, line)) => {
                    proc.stdout = Some(stdout);
                    result?;
                    if line.is_empty() {
                        return Err("sidecar closed its output".to_string());
                    }
                    decode_response(line.trim())
                }
                // The reader thread is still blocked on `read_line` and owns
                // `stdout` — it's intentionally leaked here rather than
                // joined (joining would defeat the point of the timeout).
                // `proc.stdout` stays `None`, so the caller below clears the
                // whole cached process and the next `speak()` respawns a
                // fresh sidecar rather than trying to reuse a half-broken one.
                Err(_) => Err("sidecar timed out waiting for a response".to_string()),
            }
        };

        let response = match write_and_read() {
            Ok(r) => r,
            Err(e) => {
                // Drop the dead process so the next call respawns it. A
                // write/read failure (including a timeout) does not imply
                // the child has actually exited — `Child::drop` does not
                // kill the OS process, so an unresponsive sidecar would
                // otherwise be silently abandoned/orphaned (still running,
                // still holding a loaded model) with nothing left able to
                // reach it, since `self.process` is about to be cleared.
                // Killing first (best-effort; a harmless no-op if the
                // process already exited) also unblocks the leaked reader
                // thread on the timeout path by closing its stdout pipe.
                if let Ok(mut guard) = self.process.lock() {
                    if let Some(mut proc) = guard.take() {
                        let _ = proc.child.kill();
                    }
                }
                return Err(e);
            }
        };

        if !is_current(response.id, self.generation.load(Ordering::SeqCst)) {
            let _ = std::fs::remove_file(&out_path);
            return Ok(());
        }

        if response.status != "ok" {
            return Err(response.message.unwrap_or_else(|| "tts synthesis failed".to_string()));
        }

        // Hand the WAV path to the dedicated audio thread — the OutputStream
        // and Sink themselves are created, played, and dropped there, never
        // here.
        self.audio_tx
            .send(PlaybackCommand::Play(out_path))
            .map_err(|_| "audio playback thread is gone".to_string())?;

        Ok(())
    }
}
