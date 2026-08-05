use std::sync::atomic::{AtomicU64, Ordering};

/// Locally-unique ids, to avoid pulling in the `uuid` crate for a handful of
/// call sites that never leave this machine.
///
/// The timestamp alone (the original `snippets.rs` implementation) is not
/// enough once ids are minted in loops — importing a batch of snippets, or
/// creating notes quickly — because two calls can land in the same nanosecond
/// tick on Windows, whose clock granularity is far coarser than a nanosecond.
/// The counter makes collisions impossible within a process.
static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    // Hex only, with no separators that could be read as glob metacharacters —
    // note ids become Tauri window labels matched against a `note-*` pattern.
    format!("{nanos:x}{seq:x}")
}

/// Unix milliseconds. Stored on clipboard entries and notes so the UI can show
/// "3 minutes ago" without a second time source.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_even_in_a_tight_loop() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 1000, "no collisions across rapid successive calls");
    }

    #[test]
    fn ids_contain_only_hex_so_they_are_safe_as_window_labels() {
        let id = new_id();
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit()),
            "id {id} must not contain glob metacharacters"
        );
    }
}
