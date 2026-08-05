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
    /// Queue a clip onto the *existing* sink. `gen` is the utterance it belongs
    /// to; a clip from a superseded utterance is dropped and its file unlinked.
    Enqueue { generation: u64, path: std::path::PathBuf },
    /// No more clips are coming for this utterance. Once the sink drains after
    /// this, `tts-ended` fires.
    EndOfUtterance { generation: u64 },
    /// Barge-in or shutdown.
    Stop,
}

/// Everything the audio thread owns. All of it stays local to that one thread —
/// see the `!Send` note above.
struct AudioState {
    /// Created lazily on the first clip and then kept for the life of the
    /// thread. The previous implementation dropped and rebuilt the stream for
    /// every clip, which is precisely what made gapless sentence-by-sentence
    /// playback impossible.
    stream: Option<(rodio::OutputStream, rodio::OutputStreamHandle)>,
    sink: Option<rodio::Sink>,
    /// True between `tts-started` and its matching `tts-ended`.
    speaking: bool,
    /// Whether `EndOfUtterance` has arrived for the utterance in flight.
    end_signalled: bool,
    generation: u64,
    /// Temp WAVs to unlink once playback is finished with them. They cannot be
    /// removed right after `append`: `rodio::Decoder` holds the file open and
    /// reads lazily, so on Windows the unlink would just fail silently.
    temp_paths: Vec<std::path::PathBuf>,
}

/// Owns the long-lived Python sidecar and a channel to the dedicated audio
/// playback thread. One instance lives in Tauri's managed state for the
/// app's lifetime.
pub struct TtsSidecar {
    process: Mutex<Option<SidecarProcess>>,
    audio_tx: std::sync::mpsc::Sender<PlaybackCommand>,
    synth_tx: std::sync::mpsc::Sender<SynthCommand>,
    synth_rx: Mutex<Option<std::sync::mpsc::Receiver<SynthCommand>>>,
    /// Bumped once per *utterance*, not per request. Under streaming a
    /// per-request bump would make every sentence invalidate the one before it.
    generation: AtomicU64,
    /// The sidecar protocol's line-pairing id, which carries no cancellation
    /// meaning and so must not share the generation counter.
    request_seq: AtomicU64,
    /// Set once from `.setup()`; only used to emit events. `TtsSidecar::new()`
    /// runs at `.manage()` time, before an AppHandle exists.
    ///
    /// `Arc`, not a bare `OnceLock`: cloning a `OnceLock` produces an
    /// independent cell, so a worker thread holding a clone would never see the
    /// handle that `attach()` later stores.
    app: AppSlot,
}

type AppSlot = std::sync::Arc<std::sync::OnceLock<tauri::AppHandle>>;

/// One sentence to synthesize, carrying everything the worker needs so it never
/// has to touch the AppHandle for paths.
pub struct SynthJob {
    pub generation: u64,
    pub text: String,
    pub python: std::path::PathBuf,
    pub script: std::path::PathBuf,
    pub out_dir: std::path::PathBuf,
    pub voice: String,
}

enum SynthCommand {
    Speak(Box<SynthJob>),
    End { generation: u64 },
}

fn emit_u64(app: &AppSlot, event: &str, payload: u64) {
    use tauri::Emitter;
    if let Some(app) = app.get() {
        let _ = app.emit(event, payload);
    }
}

impl Default for TtsSidecar {
    fn default() -> Self {
        let (audio_tx, audio_rx) = std::sync::mpsc::channel::<PlaybackCommand>();
        let (synth_tx, synth_rx) = std::sync::mpsc::channel::<SynthCommand>();
        let app: AppSlot = std::sync::Arc::new(std::sync::OnceLock::new());

        // The one and only thread that ever touches OutputStream/Sink. All of
        // it stays in local variables here — never stored in shared state — so
        // creation, playback, and drop all happen on this same thread.
        let audio_app = app.clone();
        std::thread::spawn(move || {
            use std::sync::mpsc::RecvTimeoutError;
            let mut st = AudioState {
                stream: None,
                sink: None,
                speaking: false,
                end_signalled: false,
                generation: 0,
                temp_paths: Vec::new(),
            };

            loop {
                // Poll only while speaking, so an idle app costs nothing. A
                // blocking `sleep_until_end()` is not an option: it is one-shot
                // per Sink (rodio takes the receiver and never restores it) and
                // it would block this thread, making barge-in impossible.
                let cmd = if st.speaking {
                    match audio_rx.recv_timeout(std::time::Duration::from_millis(120)) {
                        Ok(c) => Some(c),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match audio_rx.recv() {
                        Ok(c) => Some(c),
                        Err(_) => break,
                    }
                };

                match cmd {
                    Some(PlaybackCommand::Stop) => {
                        if let Some(sink) = st.sink.take() {
                            // Not `clear()` — that calls sleep_until_end()
                            // internally and can stall.
                            sink.stop();
                        }
                        finish_utterance(&mut st, &audio_app);
                    }
                    Some(PlaybackCommand::Enqueue { generation, path }) => {
                        if generation < st.generation {
                            let _ = std::fs::remove_file(&path); // superseded
                            continue;
                        }
                        if generation > st.generation {
                            // A new utterance began without a Stop.
                            st.generation = generation;
                            st.end_signalled = false;
                        }
                        if let Err(e) = enqueue_clip(&mut st, &path) {
                            eprintln!("[synapse] tts playback failed: {e}");
                            let _ = std::fs::remove_file(&path);
                            continue;
                        }
                        st.temp_paths.push(path);
                        if !st.speaking {
                            st.speaking = true;
                            // Emitted when audio is genuinely audible, not
                            // merely requested.
                            emit_u64(&audio_app, "tts-started", generation);
                        }
                    }
                    Some(PlaybackCommand::EndOfUtterance { generation }) if generation >= st.generation => {
                        st.end_signalled = true;
                    }
                    // An End for an utterance we have already moved past.
                    Some(PlaybackCommand::EndOfUtterance { .. }) => {}
                    None => {}
                }

                // `sink.empty()` is also true in the gap between one sentence
                // finishing and the next finishing synthesis, so the drain
                // check has to wait for the end marker. The channel is FIFO and
                // the worker sends End after the last clip, so the marker can
                // never overtake the audio ahead of it.
                if st.speaking && st.end_signalled && st.sink.as_ref().is_none_or(|s| s.empty()) {
                    finish_utterance(&mut st, &audio_app);
                }
            }
        });

        Self {
            process: Mutex::new(None),
            audio_tx,
            synth_tx,
            synth_rx: Mutex::new(Some(synth_rx)),
            generation: AtomicU64::new(0),
            request_seq: AtomicU64::new(0),
            app,
        }
    }
}

fn enqueue_clip(st: &mut AudioState, path: &std::path::Path) -> Result<(), String> {
    if st.stream.is_none() {
        st.stream = Some(rodio::OutputStream::try_default().map_err(|e| e.to_string())?);
    }
    let handle = &st.stream.as_ref().expect("just created").1;
    if st.sink.is_none() {
        // `Sink::new_idle` keeps its queue alive when empty, so an idle sink
        // holds the device open and a later `append` resumes seamlessly. That
        // is what makes sentence-to-sentence playback gapless.
        st.sink = Some(rodio::Sink::try_new(handle).map_err(|e| e.to_string())?);
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let source = rodio::Decoder::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
    st.sink.as_ref().expect("just created").append(source);
    Ok(())
}

/// Emits `tts-ended` exactly once per `tts-started` and cleans up the temp
/// WAVs, which are only safe to unlink now that nothing is decoding them.
fn finish_utterance(st: &mut AudioState, app: &AppSlot) {
    for path in st.temp_paths.drain(..) {
        let _ = std::fs::remove_file(path);
    }
    st.end_signalled = false;
    if st.speaking {
        st.speaking = false;
        emit_u64(app, "tts-ended", st.generation);
    }
}

impl TtsSidecar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hands the sidecar an AppHandle (for events) and starts the synthesis
    /// worker. Called once from `.setup()`; `new()` runs earlier, at
    /// `.manage()` time, when no handle exists yet.
    pub fn attach(&self, app: tauri::AppHandle) {
        if self.app.set(app).is_err() {
            return; // already attached
        }
        let Ok(mut slot) = self.synth_rx.lock() else { return };
        let Some(rx) = slot.take() else { return };

        let audio_tx = self.audio_tx.clone();
        let app_slot = self.app.clone();
        // The worker needs to consult the live generation to skip superseded
        // work, and needs the sidecar's process/protocol machinery — but
        // `self` lives in Tauri's managed state, so it is reached through the
        // AppHandle rather than captured.
        std::thread::spawn(move || {
            for cmd in rx {
                let Some(app) = app_slot.get() else { continue };
                let sidecar = {
                    use tauri::Manager;
                    app.state::<TtsSidecar>()
                };

                match cmd {
                    SynthCommand::End { generation } => {
                        let _ = audio_tx.send(PlaybackCommand::EndOfUtterance { generation });
                    }
                    SynthCommand::Speak(job) => {
                        // Check 1: skip a superseded job before paying for a
                        // multi-second synthesis at all.
                        if !is_current(job.generation, sidecar.generation.load(Ordering::SeqCst)) {
                            continue;
                        }
                        match sidecar.synthesize(&job) {
                            Ok(path) => {
                                // Check 2: the utterance may have been barged
                                // in on while we were synthesizing.
                                if !is_current(job.generation, sidecar.generation.load(Ordering::SeqCst)) {
                                    let _ = std::fs::remove_file(&path);
                                    continue;
                                }
                                let _ = audio_tx.send(PlaybackCommand::Enqueue {
                                    generation: job.generation,
                                    path,
                                });
                            }
                            Err(e) => {
                                eprintln!("[synapse] tts synthesis failed: {e}");
                                use tauri::Emitter;
                                let _ = app.emit("tts-error", e);
                                // Still end the utterance, or the UI would sit
                                // in "speaking" forever.
                                let _ = audio_tx.send(PlaybackCommand::EndOfUtterance {
                                    generation: job.generation,
                                });
                            }
                        }
                    }
                }
            }
        });
    }

    /// Starts a new utterance, invalidating anything still queued from the
    /// previous one.
    pub fn begin_utterance(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn enqueue(&self, job: SynthJob) {
        let _ = self.synth_tx.send(SynthCommand::Speak(Box::new(job)));
    }

    pub fn end_utterance(&self, generation: u64) {
        let _ = self.synth_tx.send(SynthCommand::End { generation });
    }

    /// Barge-in. Returns immediately.
    ///
    /// Deliberately does NOT drain the synthesis queue (unnecessary — the
    /// generation bump makes every queued job a no-op) and does NOT kill the
    /// sidecar to cancel work in flight. Killing would discard the loaded model
    /// and make the next utterance pay a multi-second reload, to save one
    /// synthesis that gets discarded anyway.
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.audio_tx.send(PlaybackCommand::Stop);
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

    fn ensure_process(&self, python_path: &std::path::Path, sidecar_path: &std::path::Path) -> Result<(), String> {
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
        *guard = Some(SidecarProcess {
            child,
            stdin,
            stdout: Some(BufReader::new(stdout)),
        });
        Ok(())
    }

    /// Synthesizes one chunk to a WAV and returns its path. Does NOT play it —
    /// playback is the audio thread's job, and separating the two is what lets
    /// sentence N+1 synthesize while sentence N is still being heard.
    ///
    /// Blocking, and called only from the single synthesis worker, so the
    /// `process` mutex is uncontended. A dead sidecar (write/read failure)
    /// clears the cached process so the next call respawns it, and is surfaced
    /// as an `Err` for the caller to fall back to OS-native TTS.
    fn synthesize(&self, job: &SynthJob) -> Result<std::path::PathBuf, String> {
        self.ensure_process(&job.python, &job.script)?;

        // The sidecar protocol id is its own sequence: it pairs a response line
        // with its request and carries no cancellation meaning, so it must not
        // share the per-utterance generation counter.
        let request_id = self.request_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let out_path = job.out_dir.join(format!("tts_{request_id}.wav"));
        let request = SidecarRequest {
            id: request_id,
            text: job.text.clone(),
            voice: job.voice.clone(),
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

        // Pairs the response line with the request we just sent. Requests are
        // strictly serial on this one worker, so a mismatch means the sidecar's
        // stream has desynchronised and the process is no longer trustworthy.
        if !is_current(response.id, request_id) {
            let _ = std::fs::remove_file(&out_path);
            return Err("sidecar response did not match its request".to_string());
        }

        if response.status != "ok" {
            let _ = std::fs::remove_file(&out_path);
            return Err(response.message.unwrap_or_else(|| "tts synthesis failed".to_string()));
        }

        Ok(out_path)
    }
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
        let response = decode_response(r#"{"id":3,"status":"error","message":"boom"}"#).expect("valid response");
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
        assert!(
            !is_current(4, 5),
            "a response to an older request must not be treated as current"
        );
    }
}
