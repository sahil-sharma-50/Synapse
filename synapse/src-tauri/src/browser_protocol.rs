use serde_json::Value;
use std::io::{Read, Write};

pub const ADDRESS: &str = "127.0.0.1:47321";
pub const HOST: &str = "com.synapse.browser";
pub const MAX_MESSAGE: usize = 256 * 1024;

pub fn read_frame(reader: &mut impl Read) -> Result<Value, String> {
    let mut length = [0; 4];
    reader.read_exact(&mut length).map_err(|e| e.to_string())?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE {
        return Err("Invalid browser message length".into());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn write_frame(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MESSAGE {
        return Err("Browser message too large".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(|e| e.to_string())?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

pub fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new(HOST, "bridge").map_err(|e| e.to_string())
}

pub fn manifest() -> Result<Value, String> {
    let path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(format!("{HOST}.json"));
    serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Chrome registration missing. Run register.ps1.".to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn authenticate(message: &Value, token: &str, origins: &Value) -> bool {
    message["version"] == 1
        && message["token"].as_str() == Some(token)
        && origins
            .as_array()
            .is_some_and(|origins| origins.iter().any(|origin| origin == &message["origin"]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn framing_and_authentication_fail_closed() {
        let mut bytes = Vec::new();
        let message = json!({"version":1,"token":"secret","origin":"chrome-extension://allowed/"});
        write_frame(&mut bytes, &message).unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice()).unwrap(), message);
        assert!(read_frame(&mut [0u8; 4].as_slice()).is_err());
        assert!(read_frame(&mut ((MAX_MESSAGE + 1) as u32).to_le_bytes().as_slice()).is_err());
        assert!(read_frame(&mut &bytes[..bytes.len() - 1]).is_err());
        let origins = json!(["chrome-extension://allowed/"]);
        assert!(authenticate(&message, "secret", &origins));
        assert!(!authenticate(&message, "wrong", &origins));
        assert!(!authenticate(&message, "secret", &json!([])));
        assert!(!authenticate(
            &json!({"version":2,"token":"secret","origin":"chrome-extension://allowed/"}),
            "secret",
            &origins
        ));
    }
}
