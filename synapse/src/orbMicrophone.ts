import type { FrameProcessorOptions, MicVAD } from "@ricky0123/vad-web";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import type { VoiceSettings } from "./models";

export function voiceCommand(
  transcript: string,
  requireAddress: boolean,
  prefix = "Synapse",
): string {
  const text = transcript.trim();
  const literal = (prefix.trim() || "Synapse")
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const addressed = new RegExp(
    `^(?:hey\\s+)?${literal}(?=$|[\\s,:.!?—-])[\\s,:.!?—-]*(.*)$`,
    "isu",
  ).exec(text);
  return addressed ? addressed[1].trim() : requireAddress ? "" : text;
}

export function speechDetectionOptions(voice: VoiceSettings): FrameProcessorOptions {
  const threshold = Math.min(0.9, 0.5 + voice.speech_threshold * 10);
  return {
    positiveSpeechThreshold: threshold,
    negativeSpeechThreshold: threshold - 0.2,
    minSpeechMs: 320,
    preSpeechPadMs: 320,
    redemptionMs: voice.silence_ms,
    submitUserSpeechOnPause: false,
  };
}

export async function openOrbMicrophone(
  voice: VoiceSettings,
  signal: AbortSignal,
  onStart: () => void,
  onEnd: (samples: number[], sampleRate: number) => void,
  onLevel: (level: number) => void,
  onError: (error: string) => void,
  canListen: () => boolean,
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
  let vad: MicVAD | undefined;
  let stopped = false;
  let destroying = false;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(healthTimer);
    if (!stopped) {
      stopped = true;
      stream.getTracks().forEach((track) => track.stop());
    }
    // Initialization can finish after cancellation; dispose its detector when it arrives.
    if (vad && !destroying) {
      destroying = true;
      void vad
        .destroy()
        .catch(console.error)
        .finally(() => {
          if (context && context.state !== "closed") void context.close();
        });
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) {
      stop();
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track)
      throw new Error(
        "No microphone audio track is available. Check Windows Sound input settings.",
      );
    if (/stereo mix|what u hear|wave out mix/i.test(track.label || ""))
      throw new Error(
        "AI is using a computer-audio input. Select your microphone in Windows Sound settings, then reopen AI.",
      );
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
    const { MicVAD, FrameProcessor, Message } = await import("@ricky0123/vad-web");
    if (signal.aborted) {
      stop();
      return;
    }
    context = new AudioContext({ sampleRate: 16_000 });
    const options = speechDetectionOptions(voice);
    let lastFrame = Date.now();
    let segmentMs = 0;
    let inSegment = false;
    let probability = { isSpeech: 0, notSpeech: 1 };
    // Reuse the neural scores, but segment only user-turn frames so playback cannot leak in.
    const input = new FrameProcessor(
      async () => probability,
      () => {},
      options,
      32,
    );
    input.resume();
    const fail = (message: string) => {
      if (stopped) return;
      stop();
      onError(message);
    };
    vad = await MicVAD.new({
      ...options,
      model: "v5",
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
      ortConfig: (ort) => {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = { mjs: wasmModuleUrl, wasm: "/vad/ort-wasm-simd-threaded.wasm" };
      },
      audioContext: context,
      getStream: async () => stream,
      pauseStream: async () => {}, // This function owns and stops the track.
      resumeStream: async () => stream,
      startOnLoad: true,
      onFrameProcessed: async (score, frame) => {
        if (stopped) return;
        lastFrame = Date.now();
        if (!canListen()) {
          input.reset();
          inSegment = false;
          segmentMs = 0;
          onLevel(0);
          return;
        }
        probability = score;
        await input.process(frame, (event) => {
          if (stopped || !canListen()) return;
          if (event.msg === Message.SpeechStart) {
            inSegment = true;
            segmentMs = 0;
          } else if (event.msg === Message.SpeechRealStart) {
            onStart();
          } else if (event.msg === Message.SpeechEnd || event.msg === Message.VADMisfire) {
            inSegment = false;
            segmentMs = 0;
            if (event.msg === Message.SpeechEnd) onEnd(Array.from(event.audio), 16000);
          }
        });
        if (stopped || !canListen()) {
          input.reset();
          onLevel(0);
          return;
        }
        const level = Math.sqrt(
          frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length,
        );
        onLevel(score.isSpeech >= options.negativeSpeechThreshold ? level : 0);
        if (inSegment && (segmentMs += frame.length / 16) >= 60_000) {
          fail("Voice command exceeded one minute. Reopen AI and use a shorter command.");
        }
      },
    });
    if (signal.aborted || stopped) {
      stop();
      return;
    }
    track.onended = () => fail("Microphone disconnected. Reopen AI to try again.");
    await context.resume();
    if (signal.aborted || stopped) {
      stop();
      return;
    }
    healthTimer = setInterval(() => {
      if (!signal.aborted && (track.muted || Date.now() - lastFrame >= 5000)) {
        fail(
          `No microphone audio received from ${track.label || "the selected input"}. Check its mute switch and Windows Sound input settings, then reopen AI.`,
        );
      }
    }, 5000);
  } catch (error) {
    stop();
    if (!vad && context && context.state !== "closed") void context.close();
    throw error;
  }
}
