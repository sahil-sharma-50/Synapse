use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let load_start = Instant::now();
    let mut model = ParakeetTDT::from_pretrained("model", None)?;
    println!("model loaded in {:.2}s", load_start.elapsed().as_secs_f32());

    let transcribe_start = Instant::now();
    let result = model.transcribe_file("jfk.wav", Some(TimestampMode::Sentences))?;
    let elapsed = transcribe_start.elapsed().as_secs_f32();

    println!("transcription ({elapsed:.2}s): {}", result.text);
    Ok(())
}
