use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat};
use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Parakeet expects 16 kHz mono. The microphone is opened at whatever it
/// natively supports (commonly 44.1/48 kHz stereo) and resampled down —
/// opening the device directly at 16 kHz mono fails on most hardware with
/// "The requested stream configuration is not supported by the device."
const TARGET_SAMPLE_RATE: u32 = 16_000;

const SILENCE_TIMEOUT_MS: u64 = 900;
const MAX_RECORD_MS: u128 = 20_000;
/// If the user never speaks, don't hang for the full MAX_RECORD_MS.
const NO_SPEECH_TIMEOUT_MS: u128 = 6_000;
const SILENCE_RMS_THRESHOLD: f32 = 0.015;

static MODEL: OnceLock<Mutex<ParakeetTDT>> = OnceLock::new();
static STOP: AtomicBool = AtomicBool::new(false);

/// Lets the UI end recording early (clicking the listening pill, or Esc).
pub fn request_stop() {
    STOP.store(true, Ordering::SeqCst);
}

/// Loading the model takes ~1.2s (measured in spikes/asr-spike) — done once
/// on a background thread at app startup so the first dictation isn't slow.
///
/// NOTE: loads from a fixed relative "model" directory for now. Production
/// should download this to the app data dir on first run (PRD §6.2) and
/// point here instead — tracked for M5 onboarding.
pub fn preload_model() {
    std::thread::spawn(|| match ParakeetTDT::from_pretrained("model", None) {
        Ok(model) => {
            let _ = MODEL.set(Mutex::new(model));
            println!("[synapse] ASR model loaded");
        }
        Err(e) => eprintln!("[synapse] failed to load ASR model: {e}"),
    });
}

struct SilenceState {
    heard_speech: bool,
    silence_since: Option<Instant>,
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Downmixes to mono and resamples to TARGET_SAMPLE_RATE using a box filter
/// (averaging each output sample's source window). The averaging doubles as
/// crude anti-aliasing, which plain nearest-neighbour decimation would miss.
fn to_mono_16k(interleaved: &[f32], from_rate: u32, channels: u16) -> Vec<f32> {
    let mono: Vec<f32> = if channels <= 1 {
        interleaved.to_vec()
    } else {
        interleaved
            .chunks(channels as usize)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };

    if from_rate == TARGET_SAMPLE_RATE {
        return mono;
    }

    let ratio = from_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = ((((i + 1) as f64) * ratio).ceil() as usize).min(mono.len());
        if start >= end {
            break;
        }
        out.push(mono[start..end].iter().sum::<f32>() / (end - start) as f32);
    }
    out
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<Vec<f32>>>,
    state: Arc<Mutex<SilenceState>>,
    done: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let samples: Vec<f32> = data.iter().map(|s| f32::from_sample(*s)).collect();
                buffer.lock().unwrap().extend_from_slice(&samples);

                let mut st = state.lock().unwrap();
                if rms(&samples) > SILENCE_RMS_THRESHOLD {
                    st.heard_speech = true;
                    st.silence_since = None;
                } else if st.heard_speech && st.silence_since.is_none() {
                    st.silence_since = Some(Instant::now());
                }
                if let Some(since) = st.silence_since {
                    if since.elapsed().as_millis() as u64 >= SILENCE_TIMEOUT_MS {
                        done.store(true, Ordering::SeqCst);
                    }
                }
            },
            |err| eprintln!("[synapse] mic stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Records from the default microphone until trailing silence, a manual stop,
/// or a timeout, then transcribes. Blocking — call from a background thread,
/// never the UI/event-loop thread.
pub fn record_and_transcribe() -> Result<String, String> {
    STOP.store(false, Ordering::SeqCst);

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no microphone found — check that an input device is connected and enabled")?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("could not read microphone config: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let in_rate = config.sample_rate.0;
    let channels = config.channels;
    println!("[synapse] mic: {in_rate} Hz, {channels} ch, {sample_format:?}");

    let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
    let done = Arc::new(AtomicBool::new(false));
    let state = Arc::new(Mutex::new(SilenceState {
        heard_speech: false,
        silence_since: None,
    }));

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::I32 => build_stream::<i32>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::I8 => build_stream::<i8>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        SampleFormat::U8 => build_stream::<u8>(&device, &config, buffer.clone(), state.clone(), done.clone()),
        other => Err(format!("unsupported microphone sample format: {other:?}")),
    }?;

    stream.play().map_err(|e| format!("could not start microphone: {e}"))?;

    let start = Instant::now();
    loop {
        if done.load(Ordering::SeqCst) || STOP.load(Ordering::SeqCst) {
            break;
        }
        let elapsed = start.elapsed().as_millis();
        if elapsed >= MAX_RECORD_MS {
            break;
        }
        if elapsed >= NO_SPEECH_TIMEOUT_MS && !state.lock().unwrap().heard_speech {
            drop(stream);
            return Err("no speech detected — is the right microphone selected?".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stream);

    let raw = buffer.lock().unwrap().clone();
    if raw.is_empty() {
        return Err("no audio captured from the microphone".into());
    }

    let samples = to_mono_16k(&raw, in_rate, channels);
    println!("[synapse] captured {:.1}s of audio", samples.len() as f32 / TARGET_SAMPLE_RATE as f32);

    let model_lock = MODEL
        .get()
        .ok_or("speech model still loading — try again in a moment")?;
    let mut model = model_lock.lock().map_err(|_| "model lock poisoned")?;
    let result = model
        .transcribe_samples(samples, TARGET_SAMPLE_RATE, 1, Some(TimestampMode::Sentences))
        .map_err(|e| e.to_string())?;

    Ok(result.text)
}
