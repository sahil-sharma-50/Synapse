use keyring::Entry;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use tauri::Emitter;

const KEYRING_SERVICE: &str = "com.synapse.app";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
}

impl Provider {
    fn key_username(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic_api_key",
            Provider::Openai => "openai_api_key",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "anthropic" => Ok(Provider::Anthropic),
            "openai" => Ok(Provider::Openai),
            other => Err(format!("unknown provider: {other}")),
        }
    }
}

fn entry(provider: Provider) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, provider.key_username()).map_err(|e| e.to_string())
}

/// Stores the key, then reads it back through a *fresh* entry to prove it
/// actually landed in the OS keystore. Without this check a keystore that
/// doesn't persist (see the keyring note in Cargo.toml) reports success and
/// leaves the panel permanently stuck on "No key" with nothing to explain it.
pub fn set_api_key(provider: Provider, key: &str) -> Result<(), String> {
    entry(provider)?
        .set_password(key)
        .map_err(|e| e.to_string())?;

    match entry(provider)?.get_password() {
        Ok(stored) if stored == key => Ok(()),
        _ => Err("key did not persist to the OS keychain".to_string()),
    }
}

pub fn has_api_key(provider: Provider) -> bool {
    entry(provider)
        .and_then(|e| e.get_password().map_err(|err| err.to_string()))
        .is_ok()
}

pub fn delete_api_key(provider: Provider) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        // Removing a key that isn't there is the state the caller wanted.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn get_api_key(provider: Provider) -> Result<String, String> {
    entry(provider)?
        .get_password()
        .map_err(|_| "no API key set for this provider".to_string())
}

/// Streams a chat completion, emitting an `ai-delta` event per text chunk to
/// the given window, and returns the full accumulated response text.
/// Blocking + a plain `BufReader` line loop rather than async reqwest + tokio
/// — SSE is line-delimited, so this needs no async runtime, consistent with
/// the rest of the app's thread-per-task style (see asr.rs).
/// `model` is resolved by the caller from settings — this module does no file
/// I/O, so it stays a pure HTTP/SSE client.
pub fn stream_chat(
    app: &tauri::AppHandle,
    provider: Provider,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let api_key = get_api_key(provider)?;
    let client = reqwest::blocking::Client::new();

    let response = match provider {
        Provider::Anthropic => client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                // Headroom for thinking: on claude-opus-5 (offered in the model
                // picker) thinking is on by default and max_tokens caps thinking
                // *plus* response text, so a tight limit truncates mid-answer.
                "max_tokens": 16000,
                "stream": true,
                "messages": [{"role": "user", "content": prompt}],
            }))
            .send(),
        Provider::Openai => client
            .post("https://api.openai.com/v1/chat/completions")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                "stream": true,
                "messages": [{"role": "user", "content": prompt}],
            }))
            .send(),
    }
    .map_err(|e| format!("request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }

    let reader = BufReader::new(response);
    let mut full_text = String::new();

    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let Ok(event): Result<Value, _> = serde_json::from_str(data) else {
            continue;
        };

        let delta_text = match provider {
            Provider::Anthropic => {
                if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                    continue;
                }
                event["delta"]["text"].as_str()
            }
            Provider::Openai => event["choices"][0]["delta"]["content"].as_str(),
        };

        if let Some(text) = delta_text {
            full_text.push_str(text);
            let _ = app.emit("ai-delta", text);
        }
    }

    Ok(full_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression guard for a silent-failure bug: `keyring` falls back to an
    /// in-memory `mock` store unless a platform-store feature is enabled, and
    /// the mock hands out a fresh empty credential per `Entry::new`. That made
    /// `set_api_key` report success while `has_api_key` stayed false forever —
    /// the key never left the process. Storing and reading through two
    /// *separate* entries is what distinguishes a real keystore from the mock.
    #[test]
    fn api_key_survives_a_separate_entry() {
        let user = "test_roundtrip_key";
        let written = Entry::new(KEYRING_SERVICE, user).expect("build write entry");
        written.set_password("sk-test-value").expect("set password");

        let reread = Entry::new(KEYRING_SERVICE, user).expect("build read entry");
        let got = reread.get_password();
        let _ = reread.delete_credential();

        assert_eq!(got.expect("key readable from a new entry"), "sk-test-value");
    }
}
