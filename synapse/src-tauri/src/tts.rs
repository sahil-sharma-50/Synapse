//! OS-native text-to-speech — no API key, fully offline. Chosen over cloud
//! TTS (e.g. OpenAI) specifically to avoid requiring a second provider key
//! just to hear a response read back.
//!
//! This is the fallback path, used when the local pocket-tts engine isn't
//! installed. It is deliberately NOT wired into the sentence-streaming
//! pipeline: each chunk would cost a fresh `powershell.exe` plus an
//! `Add-Type System.Speech` JIT (~300-600 ms, more than the synthesis it
//! replaces), and consecutive processes cannot queue on one SAPI voice, so
//! sentences would overlap or gap. Whole-utterance is strictly better here.

use std::sync::Mutex;

/// The running speech process, so `stop()` can interrupt it. `System.Speech`'s
/// `Speak()` blocks inside the child with no way to signal it from outside —
/// terminating the process is the only interruption available.
static CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn spawn(text: &str) -> Result<std::process::Child, String> {
    #[cfg(target_os = "windows")]
    {
        // System.Speech via PowerShell — no extra Rust dependency, and
        // SAPI has no stable public C API worth binding to for this.
        let escaped = text.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Speech; \
             (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{escaped}')"
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        // powershell.exe is a console-subsystem binary; spawned from a GUI app
        // with no console of its own, Windows flashes a console window on
        // screen for the life of the call. The pocket-tts sidecar already sets
        // this; the fallback path was missing it.
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        return cmd.spawn().map_err(|e| e.to_string());
    }

    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("say")
            .arg(text)
            .spawn()
            .map_err(|e| e.to_string());
    }

    #[allow(unreachable_code)]
    Err("text-to-speech not implemented on this platform".into())
}

/// Speaks and blocks until finished. Call from a background thread.
pub fn speak(text: &str) -> Result<(), String> {
    let child = spawn(text)?;
    {
        let mut guard = CHILD.lock().map_err(|_| "tts child lock poisoned")?;
        // Replacing the previous child here would leak it, so stop first.
        if let Some(mut old) = guard.take() {
            let _ = old.kill();
        }
        *guard = Some(child);
    }

    // Wait outside the lock, or `stop()` could never take the lock to kill us.
    loop {
        std::thread::sleep(std::time::Duration::from_millis(80));
        let mut guard = CHILD.lock().map_err(|_| "tts child lock poisoned")?;
        let Some(child) = guard.as_mut() else {
            return Ok(()); // stopped from under us
        };
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                return Ok(());
            }
            Ok(None) => continue,
            Err(e) => {
                *guard = None;
                return Err(e.to_string());
            }
        }
    }
}

/// Interrupts OS-native speech. Safe to call when nothing is speaking.
///
/// Without this, a machine without the local engine would leave the orb stuck
/// in its "speaking" state with no way out — the fallback must be
/// interruptible even though it can't be streamed.
pub fn stop() {
    if let Ok(mut guard) = CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }
}

/// True while OS-native speech is in progress.
pub fn is_speaking() -> bool {
    CHILD.lock().map(|g| g.is_some()).unwrap_or(false)
}
