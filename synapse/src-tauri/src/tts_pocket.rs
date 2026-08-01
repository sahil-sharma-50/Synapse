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
    stdout: BufReader<ChildStdout>,
}

/// Owns the long-lived Python sidecar and the currently-playing audio sink.
/// One instance lives in Tauri's managed state for the app's lifetime.
pub struct TtsSidecar {
    process: Mutex<Option<SidecarProcess>>,
    sink: Mutex<Option<rodio::Sink>>,
    // Kept alive alongside `sink` — dropping the OutputStream stops playback.
    stream: Mutex<Option<rodio::OutputStream>>,
    generation: AtomicU64,
}

impl Default for TtsSidecar {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            sink: Mutex::new(None),
            stream: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

impl TtsSidecar {
    pub fn new() -> Self {
        Self::default()
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
        let mut child = Command::new(python_path)
            .arg(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to start tts sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        *guard = Some(SidecarProcess { child, stdin, stdout: BufReader::new(stdout) });
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
        if let Ok(mut sink) = self.sink.lock() {
            if let Some(s) = sink.take() {
                s.stop();
            }
        }

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.ensure_process(python_path, sidecar_path)?;

        let out_path = out_dir.join(format!("tts_{generation}.wav"));
        let request = SidecarRequest {
            id: generation,
            text: text.to_string(),
            voice: voice.to_string(),
            out_path: out_path.to_string_lossy().to_string(),
        };

        let write_and_read = || -> Result<SidecarResponse, String> {
            let mut guard = self.process.lock().map_err(|_| "sidecar lock poisoned")?;
            let proc = guard.as_mut().ok_or("sidecar not running")?;
            writeln!(proc.stdin, "{}", encode_request(&request)).map_err(|e| e.to_string())?;
            let mut line = String::new();
            proc.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if line.is_empty() {
                return Err("sidecar closed its output".to_string());
            }
            decode_response(line.trim())
        };

        let response = match write_and_read() {
            Ok(r) => r,
            Err(e) => {
                // Drop the dead process so the next call respawns it.
                if let Ok(mut guard) = self.process.lock() {
                    *guard = None;
                }
                return Err(e);
            }
        };

        if !is_current(response.id, generation) {
            let _ = std::fs::remove_file(&out_path);
            return Ok(());
        }

        if response.status != "ok" {
            return Err(response.message.unwrap_or_else(|| "tts synthesis failed".to_string()));
        }

        let (stream, handle) = rodio::OutputStream::try_default().map_err(|e| e.to_string())?;
        let sink = rodio::Sink::try_new(&handle).map_err(|e| e.to_string())?;
        let file = std::fs::File::open(&out_path).map_err(|e| e.to_string())?;
        let source = rodio::Decoder::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
        sink.append(source);

        if let Ok(mut s) = self.sink.lock() {
            *s = Some(sink);
        }
        if let Ok(mut st) = self.stream.lock() {
            *st = Some(stream);
        }

        Ok(())
    }
}
