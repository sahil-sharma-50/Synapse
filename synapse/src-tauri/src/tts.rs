/// OS-native text-to-speech — no API key, fully offline. Chosen over cloud
/// TTS (e.g. OpenAI) specifically to avoid requiring a second provider key
/// just to hear a response read back.
pub fn speak(text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // System.Speech via PowerShell — no extra Rust dependency, and
        // SAPI has no stable public C API worth binding to for this.
        let escaped = text.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Speech; \
             (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{escaped}')"
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("say")
            .arg(text)
            .output()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("text-to-speech not implemented on this platform".into())
}
