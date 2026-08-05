//! Splits streaming text into speakable chunks.
//!
//! Lives in Rust rather than the frontend for three reasons: the same splitter
//! serves the AI stream, the "Speak Selected Text" wedge (no webview involved
//! at all) and any future voice preview; it is pure and table-testable under
//! `cargo test --lib` alongside `settings.rs` and `ai.rs`; and it keeps the
//! `ai-delta` event and the panel's render path completely untouched.

/// Below this, a chunk isn't worth a synthesis round-trip on its own — "Hi."
/// would become a 300 ms clip followed by an audible stall while the next
/// sentence is generated. Short chunks merge forward instead.
const MIN_CHARS: usize = 40;

/// Above this we flush at the last word break even with no terminator in
/// sight, so an unpunctuated paragraph, a list, or a markdown table can't
/// stall playback waiting for a full stop that never arrives.
const MAX_CHARS: usize = 320;

/// Words that end in a period without ending a sentence.
const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "vs", "etc", "eg", "ie", "cf", "al", "approx", "dept",
    "est", "fig", "no", "vol", "inc", "ltd", "co", "corp", "univ", "jan", "feb", "mar", "apr", "jun", "jul", "aug",
    "sep", "sept", "oct", "nov", "dec", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun", "am",
    "pm",
];

const TERMINATORS: [char; 4] = ['.', '!', '?', '…'];
/// A terminator may be followed by one of these before the whitespace.
const CLOSERS: [char; 6] = ['"', '\'', '”', '’', ')', ']'];

/// Feed it deltas as they arrive; it hands back complete chunks to speak.
pub struct SentenceSplitter {
    buf: String,
    in_code: bool,
}

impl Default for SentenceSplitter {
    fn default() -> Self {
        Self::new()
    }
}

impl SentenceSplitter {
    pub fn new() -> Self {
        Self {
            buf: String::new(),
            in_code: false,
        }
    }

    /// Appends a delta and returns every complete chunk it now contains.
    /// Returns an empty vec when the text so far doesn't reach a boundary.
    pub fn push(&mut self, delta: &str) -> Vec<String> {
        self.buf.push_str(delta);
        let mut out = Vec::new();
        while let Some(chunk) = self.take_next() {
            out.push(chunk);
        }
        out
    }

    /// The unterminated tail, once the stream is over. A reply that ends
    /// without punctuation would otherwise never be spoken.
    pub fn finish(&mut self) -> Option<String> {
        // An unterminated code fence at end-of-stream is still code; drop it
        // rather than reading backticks aloud.
        if self.in_code {
            self.buf.clear();
            self.in_code = false;
            return None;
        }
        let tail = std::mem::take(&mut self.buf);
        let tail = tail.trim();
        if tail.is_empty() {
            None
        } else {
            Some(tail.to_string())
        }
    }

    fn take_next(&mut self) -> Option<String> {
        // Fenced code blocks are consumed whole and never spoken — reading a
        // code listing aloud is noise, not information.
        if let Some(consumed) = self.consume_code_fence() {
            return consumed;
        }

        let chars: Vec<char> = self.buf.chars().collect();

        if let Some(Boundary { end, hard }) = find_boundary(&chars) {
            // `end` is a char index; convert to a byte index to split.
            let byte_end: usize = chars[..end].iter().map(|c| c.len_utf8()).sum();
            let chunk = self.buf[..byte_end].trim().to_string();

            // Too short to be worth its own utterance — keep buffering unless
            // waiting would be worse (we're already near the flush ceiling), or
            // the break is a hard one. A blank line after a short heading is a
            // real pause the speech should honour, not a fragment to merge.
            if !hard && chunk.chars().count() < MIN_CHARS && chars.len() < MAX_CHARS {
                return None;
            }

            self.buf = self.buf[byte_end..].to_string();
            return if chunk.is_empty() { None } else { Some(chunk) };
        }

        if chars.len() > MAX_CHARS {
            return self.flush_at_word_break(&chars);
        }

        None
    }

    /// Returns `Some(None)` when a fence was consumed but produced no speech,
    /// `None` when there was no fence to act on.
    fn consume_code_fence(&mut self) -> Option<Option<String>> {
        if self.in_code {
            // Look for the closing fence, and consume the fence line itself —
            // leaving it in the buffer would put a literal "```" into the next
            // chunk of speech.
            if let Some(pos) = find_fence(&self.buf, false) {
                let rest = &self.buf[pos..];
                self.buf = match rest.find('\n') {
                    Some(nl) => rest[nl + 1..].to_string(),
                    None => String::new(),
                };
                self.in_code = false;
                return Some(None);
            }
            // Still inside an unfinished block: hold everything, emit nothing.
            return Some(None);
        }

        // An opening fence with text before it: speak that text first, and
        // pick the fence up on the next call.
        if let Some(pos) = find_fence(&self.buf, true) {
            let before = self.buf[..pos].trim().to_string();
            self.buf = self.buf[pos..].to_string();
            self.in_code = true;
            // Skip past the opening fence line so the closing search doesn't
            // immediately match the one we just found.
            if let Some(nl) = self.buf.find('\n') {
                self.buf = self.buf[nl + 1..].to_string();
            } else {
                self.buf.clear();
            }
            return Some(if before.is_empty() { None } else { Some(before) });
        }

        None
    }

    fn flush_at_word_break(&mut self, chars: &[char]) -> Option<String> {
        let cut = chars[..MAX_CHARS]
            .iter()
            .rposition(|c| c.is_whitespace())
            .unwrap_or(MAX_CHARS);
        let byte_cut: usize = chars[..cut].iter().map(|c| c.len_utf8()).sum();
        let chunk = self.buf[..byte_cut].trim().to_string();
        self.buf = self.buf[byte_cut..].to_string();
        if chunk.is_empty() {
            None
        } else {
            Some(chunk)
        }
    }
}

/// Byte offset of a ``` fence at the start of a line, or `None`.
fn find_fence(text: &str, _opening: bool) -> Option<usize> {
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

struct Boundary {
    /// Char index just past the break.
    end: usize,
    /// A structural break (blank line) rather than a sentence terminator.
    /// Hard breaks are never merged away by the minimum-length rule.
    hard: bool,
}

/// Where the buffer's first complete chunk ends, or `None` if it doesn't
/// contain one yet.
fn find_boundary(chars: &[char]) -> Option<Boundary> {
    for i in 0..chars.len() {
        // A blank line always ends a chunk, punctuation or not — headings and
        // list items rarely carry a full stop.
        if chars[i] == '\n' && i + 1 < chars.len() && chars[i + 1] == '\n' {
            return Some(Boundary { end: i + 1, hard: true });
        }

        if !TERMINATORS.contains(&chars[i]) {
            continue;
        }

        // Consume one optional closing quote or bracket.
        let mut j = i + 1;
        if j < chars.len() && CLOSERS.contains(&chars[j]) {
            j += 1;
        }

        // THE key rule for streaming: if nothing follows yet, this might be a
        // decimal point or an abbreviation whose next character simply hasn't
        // arrived. Waiting costs one delta and removes a whole class of bugs.
        let &next = chars.get(j)?;
        if !next.is_whitespace() {
            continue;
        }

        if chars[i] == '.' && !ends_sentence(chars, i) {
            continue;
        }

        return Some(Boundary { end: j, hard: false });
    }
    None
}

/// Whether the period at `i` really ends a sentence.
fn ends_sentence(chars: &[char], i: usize) -> bool {
    // Decimals and version numbers: "3.14", "v1.2.3", "$4.99".
    let prev_is_digit = i > 0 && chars[i - 1].is_ascii_digit();
    let next_is_digit = chars
        .iter()
        .skip(i + 1)
        .find(|c| !c.is_whitespace())
        .is_some_and(|c| c.is_ascii_digit());
    if prev_is_digit && next_is_digit {
        return false;
    }

    // The alphabetic token immediately before the period.
    let start = chars[..i]
        .iter()
        .rposition(|c| !c.is_alphabetic() && *c != '.')
        .map(|p| p + 1)
        .unwrap_or(0);
    let token: String = chars[start..i].iter().collect::<String>().to_lowercase();

    if token.is_empty() {
        return true;
    }
    // Initials: "J. R. R. Tolkien". A lone letter before a period is never the
    // end of a sentence in practice.
    if token.chars().count() == 1 && token.chars().all(|c| c.is_alphabetic()) {
        return false;
    }
    // Dotted acronyms: "U.S.A.", "e.g."
    if token.contains('.') {
        return false;
    }
    !ABBREVIATIONS.contains(&token.as_str())
}

/// One-shot split for text that isn't streamed (the Speak Selected Text wedge).
pub fn split_all(text: &str) -> Vec<String> {
    let mut splitter = SentenceSplitter::new();
    let mut out = splitter.push(text);
    if let Some(tail) = splitter.finish() {
        out.push(tail);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_a_period_followed_by_space() {
        let chunks = split_all("The quick brown fox jumped over the lazy dog today. And then it ran away home.");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], "The quick brown fox jumped over the lazy dog today.");
        assert_eq!(chunks[1], "And then it ran away home.");
    }

    /// The streaming half of the problem: a terminator at the very end of the
    /// buffer might be a decimal point whose digits haven't arrived yet.
    #[test]
    fn holds_a_terminator_with_nothing_after_it_yet() {
        let mut s = SentenceSplitter::new();
        assert!(
            s.push("Here is a sentence of respectable length that ends here.")
                .is_empty(),
            "no trailing whitespace yet, so the boundary is not yet proven"
        );
        assert_eq!(
            s.push(" Next one."),
            vec!["Here is a sentence of respectable length that ends here."]
        );
    }

    #[test]
    fn boundary_split_across_two_deltas_is_found() {
        let mut s = SentenceSplitter::new();
        assert!(s.push("A reasonably long first sentence goes here").is_empty());
        let chunks = s.push(". And the second one follows it.");
        assert_eq!(chunks, vec!["A reasonably long first sentence goes here."]);
    }

    #[test]
    fn does_not_split_inside_a_decimal_or_version() {
        let chunks = split_all("The build is version 1.2.3 and pi is 3.14 which is close enough.");
        assert_eq!(chunks.len(), 1, "got {chunks:?}");
    }

    #[test]
    fn does_not_split_after_a_common_abbreviation() {
        let chunks = split_all("Please ask Dr. Smith about the samples, e.g. the ones from the fridge.");
        assert_eq!(chunks.len(), 1, "got {chunks:?}");
    }

    #[test]
    fn does_not_split_between_initials() {
        let chunks = split_all("The author is J. R. R. Tolkien and the book is quite long indeed.");
        assert_eq!(chunks.len(), 1, "got {chunks:?}");
    }

    /// "Hi." on its own would be a 300 ms clip followed by an audible stall
    /// while the next sentence synthesizes.
    #[test]
    fn merges_a_chunk_that_is_too_short_to_speak_alone() {
        let chunks = split_all("Hi. How are you doing today, and how was the rest of your week?");
        assert_eq!(chunks.len(), 1, "got {chunks:?}");
        assert!(chunks[0].starts_with("Hi."));
    }

    #[test]
    fn flushes_at_a_word_break_when_no_terminator_ever_arrives() {
        let text = "word ".repeat(100); // 500 chars, no punctuation at all
        let mut s = SentenceSplitter::new();
        let chunks = s.push(&text);

        assert!(!chunks.is_empty(), "playback must not wait forever");
        for chunk in &chunks {
            assert!(chunk.chars().count() <= MAX_CHARS);
            assert!(!chunk.ends_with("wor"), "never cuts mid-word: {chunk:?}");
        }
    }

    #[test]
    fn splits_on_a_blank_line_without_punctuation() {
        let chunks = split_all("A heading with no full stop at all here\n\nAnd the body text that follows it.");
        assert_eq!(chunks.len(), 2, "got {chunks:?}");
    }

    #[test]
    fn skips_a_fenced_code_block_but_speaks_the_prose_around_it() {
        let chunks = split_all(
            "Here is how you would print a greeting in Python, which is short.\n\
             ```python\n\
             print(\"hello\")\n\
             ```\n\
             That is genuinely all there is to it, believe it or not.",
        );
        let joined = chunks.join(" ");
        assert!(!joined.contains("print("), "code is not read aloud: {chunks:?}");
        assert!(!joined.contains("```"), "fences are not read aloud: {chunks:?}");
        assert!(joined.contains("print a greeting"));
        assert!(joined.contains("all there is to it"));
    }

    #[test]
    fn an_unclosed_code_fence_is_dropped_rather_than_spoken() {
        let mut s = SentenceSplitter::new();
        s.push("Some prose that is long enough to be a chunk on its own here.\n```rust\nfn main() {}");
        assert_eq!(s.finish(), None, "the dangling code block is not spoken");
    }

    #[test]
    fn finish_returns_the_unterminated_tail() {
        let mut s = SentenceSplitter::new();
        assert!(s.push("no punctuation here").is_empty());
        assert_eq!(s.finish(), Some("no punctuation here".to_string()));
        assert_eq!(s.finish(), None, "and only once");
    }

    #[test]
    fn question_and_exclamation_marks_end_sentences() {
        let chunks = split_all("Did you remember to feed the cat this morning? I really hope that you did!");
        assert_eq!(chunks.len(), 2, "got {chunks:?}");
    }

    #[test]
    fn a_closing_quote_after_the_terminator_stays_with_its_sentence() {
        let chunks = split_all("She turned around and said \"that is quite enough of that.\" Then she left the room.");
        assert_eq!(chunks.len(), 2, "got {chunks:?}");
        assert!(chunks[0].ends_with('"'), "got {:?}", chunks[0]);
    }

    #[test]
    fn empty_input_produces_nothing() {
        assert!(split_all("").is_empty());
        assert!(split_all("   \n\n  ").is_empty());
    }
}
