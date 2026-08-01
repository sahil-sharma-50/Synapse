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
