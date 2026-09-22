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
    Openrouter,
}

impl Provider {
    fn key_username(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic_api_key",
            Provider::Openai => "openai_api_key",
            Provider::Openrouter => "openrouter_api_key",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "anthropic" => Ok(Provider::Anthropic),
            "openai" => Ok(Provider::Openai),
            "openrouter" => Ok(Provider::Openrouter),
            other => Err(format!("unknown provider: {other}")),
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Provider::Anthropic => "https://api.anthropic.com/v1/messages",
            Provider::Openai => "https://api.openai.com/v1/chat/completions",
            Provider::Openrouter => "https://openrouter.ai/api/v1/chat/completions",
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
    entry(provider)?.set_password(key).map_err(|e| e.to_string())?;

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

pub(crate) fn get_api_key(provider: Provider) -> Result<String, String> {
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
///
/// `messages` is the whole conversation so far, oldest first, each entry a
/// `("user" | "assistant", text)` pair. `on_delta` is invoked for every chunk
/// as it arrives, which is what lets the caller start speaking the first
/// sentence while the rest is still generating — this module deliberately
/// knows nothing about TTS.
pub fn stream_chat(
    app: &tauri::AppHandle,
    provider: Provider,
    model: &str,
    messages: &[(String, String)],
    on_delta: &mut dyn FnMut(&str),
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    if cancelled() {
        return Err("Conversation closed".into());
    }
    let wire: Vec<Value> = messages
        .iter()
        .map(|(role, content)| json!({"role": role, "content": content}))
        .collect();
    let api_key = get_api_key(provider)?;
    let meter = crate::ai_usage::Meter::begin(
        app,
        match provider {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
            Provider::Openrouter => "openrouter",
        },
        model,
        serde_json::to_vec(&wire).map_err(|e| e.to_string())?.len(),
        if provider == Provider::Anthropic { 16000 } else { 2048 },
        false,
    )?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = match provider {
        Provider::Anthropic => client
            .post(provider.endpoint())
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
                "messages": wire,
            }))
            .send(),
        Provider::Openai | Provider::Openrouter => client
            .post(provider.endpoint())
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                "stream": true,
                "messages": wire,
                "max_tokens": 2048,
                "stream_options": {"include_usage": true},
            }))
            .send(),
    }
    .map_err(|e| format!("request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        if status.is_client_error() {
            meter.rejected()?;
        }
        let body = response.text().unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }

    let reader = BufReader::new(response);
    let mut full_text = String::new();
    let mut anthropic_usage = json!({});

    for line in reader.lines() {
        if cancelled() {
            return Err("Conversation closed".into());
        }
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
        if provider == Provider::Anthropic {
            if event["message"]["usage"].is_object() {
                anthropic_usage = event["message"]["usage"].clone();
            }
            if event["type"] == "message_delta" {
                anthropic_usage["output_tokens"] = event["usage"]["output_tokens"].clone();
                meter.settle(&anthropic_usage, None, None)?;
            }
        } else if event["usage"].is_object() {
            meter.settle(&event["usage"], event["model"].as_str(), event["id"].as_str())?;
        }

        if let Some(text) = stream_delta(provider, &event)? {
            full_text.push_str(text);
            let _ = app.emit("ai-delta", text);
            on_delta(text);
        }
    }

    Ok(full_text)
}

fn stream_delta(provider: Provider, event: &Value) -> Result<Option<&str>, String> {
    // A provider can fail after HTTP 200, including before its first token.
    if let Some(error) = event.get("error").filter(|error| !error.is_null()) {
        return Err(error["message"]
            .as_str()
            .unwrap_or("AI provider stream failed")
            .to_string());
    }
    Ok(match provider {
        Provider::Anthropic if event["type"] == "content_block_delta" => event["delta"]["text"].as_str(),
        Provider::Anthropic => None,
        Provider::Openai | Provider::Openrouter => event["choices"][0]["delta"]["content"].as_str(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "One small billable Jev decision using the saved OpenRouter key"]
    fn live_jev_connection() {
        let response = reqwest::blocking::Client::new()
            .post("https://openrouter.ai/api/alpha/decisions")
            .bearer_auth(get_api_key(Provider::Openrouter).expect("saved OpenRouter key"))
            .timeout(std::time::Duration::from_secs(30))
            .json(
                &json!({"model":"~typesafe/jev-latest", "state":{"command":"Open Chrome"},
                "questions":{"route":{"type":"choice","instructions":"Classify the user's request.",
                    "criteria":{"desktop":"Operate the computer", "chat":"Answer a question"}}}}),
            )
            .send()
            .expect("Jev connection");
        let status = response.status();
        let body: Value = response.json().expect("Jev JSON");
        assert!(status.is_success(), "Jev unavailable: {}", body["error"]);
        assert_eq!(body["answers"]["route"]["choice"], "desktop");
        println!("Jev model: {}; usage: {}", body["model"], body["usage"]);
    }

    #[test]
    #[ignore = "Uses the saved OpenAI key for one small, billable GPT-4o Mini request"]
    fn live_gpt4o_mini_connection() {
        let key = get_api_key(Provider::Openai).expect("saved OpenAI API key");
        let response = reqwest::blocking::Client::new()
            .post(Provider::Openai.endpoint())
            .bearer_auth(key)
            .timeout(std::time::Duration::from_secs(30))
            .json(&json!({"model": "gpt-4o-mini", "max_tokens": 8,
                "messages": [{"role": "user", "content": "Reply with the word Connected."}]}))
            .send()
            .expect("OpenAI connection");
        let status = response.status();
        let body: Value = response.json().expect("OpenAI JSON response");
        assert!(
            status.is_success(),
            "GPT-4o Mini request failed: {}",
            body["error"]["message"]
        );
        assert!(!body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .is_empty());
    }

    #[test]
    fn openrouter_uses_its_own_endpoint_and_credential() {
        let provider = Provider::from_str("openrouter").unwrap();
        assert!(provider == Provider::Openrouter);
        assert_eq!(provider.endpoint(), "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(provider.key_username(), "openrouter_api_key");
        assert_ne!(provider.key_username(), Provider::Openai.key_username());
    }

    #[test]
    fn openrouter_streams_text_and_reports_midstream_errors() {
        let chunk = json!({"choices": [{"delta": {"content": "Hello"}}]});
        assert_eq!(stream_delta(Provider::Openrouter, &chunk).unwrap(), Some("Hello"));
        assert_eq!(stream_delta(Provider::Openai, &chunk).unwrap(), Some("Hello"));
        let usage = json!({"choices": [], "usage": {"total_tokens": 10}});
        assert_eq!(stream_delta(Provider::Openrouter, &usage).unwrap(), None);
        let error = json!({"error": {"message": "Insufficient credits"}, "choices": []});
        assert_eq!(
            stream_delta(Provider::Openrouter, &error).unwrap_err(),
            "Insufficient credits"
        );
        let anthropic = json!({"type": "content_block_delta", "delta": {"text": "Hi"}});
        assert_eq!(stream_delta(Provider::Anthropic, &anthropic).unwrap(), Some("Hi"));
    }

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
