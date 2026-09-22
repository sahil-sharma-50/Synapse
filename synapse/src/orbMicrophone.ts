import type { VoiceSettings } from "./models";

/** Keep the first consonant; reject isolated clicks before interrupting a reply. */
export class SpeechCapture {
  private frames: Float32Array[] = [];
  private active = false;
  private voicedMs = 0;
  private quietMs = 0;
  private durationMs = 0;

  constructor(
    private sampleRate: number,
    private voice: VoiceSettings,
    private onStart: () => void,
    private onEnd: (samples: number[]) => void,
  ) {}

  push(frame: Float32Array) {
    const ms = (frame.length / this.sampleRate) * 1000;
    const level = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length);
    this.frames.push(frame);
    this.durationMs += ms;
    if (level >= this.voice.speech_threshold) {
      this.voicedMs += ms;
      this.quietMs = 0;
    } else {
      this.voicedMs = 0;
      this.quietMs += ms;
    }
    if (!this.active && this.voicedMs >= 120) {
      this.active = true;
      this.onStart();
    }
    if (!this.active) {
      while (this.durationMs > 300 && this.frames.length > 1) {
        this.durationMs -= (this.frames.shift()!.length / this.sampleRate) * 1000;
      }
    } else if (this.quietMs >= this.voice.silence_ms || this.durationMs >= 60_000) {
      const samples = new Float32Array(this.frames.reduce((size, item) => size + item.length, 0));
      let offset = 0;
      for (const item of this.frames) {
        samples.set(item, offset);
        offset += item.length;
      }
      this.frames = [];
      this.active = false;
      this.voicedMs = this.quietMs = this.durationMs = 0;
      this.onEnd(Array.from(samples));
    }
    return level;
  }
}

export async function openOrbMicrophone(
  voice: VoiceSettings,
  signal: AbortSignal,
  onStart: () => void,
  onEnd: (samples: number[], sampleRate: number) => void,
  onLevel: (level: number) => void,
  onError: (error: string) => void,
) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  const stop = () => {
    processor?.port.close();
    processor?.disconnect();
    source?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") void context.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) {
      stop();
      return;
    }
    const track = stream.getAudioTracks()[0];
    // Prefer system-wide cancellation: TTS plays through the native audio engine.
    // Older WebViews retain boolean echo cancellation. TS 5.8 predates this constraint.
    const capabilities = track.getCapabilities().echoCancellation as
      (boolean | string)[] | undefined;
    if (capabilities?.includes("all")) {
      try {
        await track.applyConstraints({
          echoCancellation: { exact: "all" } as unknown as ConstrainBoolean,
        });
      } catch (error) {
        // WebView2 can advertise "all" although the current audio device cannot
        // supply it. A rejected constraint preserves the working boolean AEC.
        if (
          !(error instanceof DOMException) ||
          !["OverconstrainedError", "NotSupportedError"].includes(error.name)
        )
          throw error;
      }
    }
    if (signal.aborted) {
      stop();
      return;
    }
    context = new AudioContext({ sampleRate: 16_000 });
    await context.audioWorklet.addModule("/orb-capture.js");
    if (signal.aborted) {
      stop();
      return;
    }
    const sampleRate = context.sampleRate;
    const capture = new SpeechCapture(sampleRate, voice, onStart, (samples) =>
      onEnd(samples, sampleRate),
    );
    processor = new AudioWorkletNode(context, "orb-capture");
    processor.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (!signal.aborted) onLevel(capture.push(data));
    };
    processor.onprocessorerror = () =>
      onError("Microphone processing stopped. Reopen AI to try again.");
    track.onended = () => {
      if (!signal.aborted) onError("Microphone disconnected. Reopen AI to try again.");
    };
    source = context.createMediaStreamSource(stream);
    source.connect(processor);
    processor.connect(context.destination); // Worklet outputs silence, never microphone feedback.
    await context.resume();
  } catch (error) {
    stop();
    throw error;
  }
}
