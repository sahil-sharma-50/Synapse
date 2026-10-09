import { afterEach, expect, it, vi } from "vitest";
import { FrameProcessor, Message, MicVAD, type RealTimeVADOptions } from "@ricky0123/vad-web";
import { openOrbMicrophone, speechDetectionOptions, voiceCommand } from "./orbMicrophone";

vi.mock("@ricky0123/vad-web", async (original) => ({
  ...(await original<typeof import("@ricky0123/vad-web")>()),
  MicVAD: { new: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("ignores computer dialogue without an address and accepts hands-free commands", () => {
  expect(voiceCommand("Click subscribe and open the next video", true)).toBe("");
  expect(voiceCommand("The narrator mentioned Synapse in passing", true)).toBe("");
  expect(voiceCommand("Synapse, pause it.", true)).toBe("pause it.");
  expect(voiceCommand("Hey Synapse open the video Sora memes", true)).toBe(
    "open the video Sora memes",
  );
  expect(voiceCommand("Synapse", true)).toBe("");
  expect(voiceCommand("pause it", false)).toBe("pause it");
});

it("matches a custom prefix literally, including phrases and punctuation", () => {
  expect(voiceCommand("Jarvis, pause it", true, "Jarvis")).toBe("pause it");
  expect(voiceCommand("Hey OK assistant open YouTube", true, "OK assistant")).toBe("open YouTube");
  expect(voiceCommand("C++, scroll down", true, "C++")).toBe("scroll down");
  expect(voiceCommand("C, scroll down", true, "C++")).toBe("");
  expect(voiceCommand("Jarvision pause", true, "Jarvis")).toBe("");
  expect(voiceCommand("Synapse pause", true, "Jarvis")).toBe("");
  expect(voiceCommand("Synapse pause", true, " ")).toBe("pause");
});

it("starts capture when advertised system echo cancellation cannot be applied", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const onStart = vi.fn();
  const onEnd = vi.fn();
  const onLevel = vi.fn();
  const destroy = vi.fn().mockResolvedValue(undefined);
  let options: Partial<RealTimeVADOptions> = {};
  vi.mocked(MicVAD.new).mockImplementation(async (value) => {
    options = value!;
    return { destroy } as unknown as MicVAD;
  });
  const stop = vi.fn();
  const applyConstraints = vi
    .fn()
    .mockRejectedValue(new DOMException("Cannot satisfy constraints", "OverconstrainedError"));
  const track = {
    label: "Microphone",
    stop,
    applyConstraints,
    getCapabilities: () => ({ echoCancellation: [true, "all"] }),
  };
  const getUserMedia = vi
    .fn()
    .mockResolvedValue({ getAudioTracks: () => [track], getTracks: () => [track] });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const resume = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 16000;
      state = "running";
      destination = {};
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      resume = resume;
      close = close;
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { close: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    },
  );
  const controller = new AbortController();
  await openOrbMicrophone(
    { auto_stop_on_silence: true, silence_ms: 900, speech_threshold: 0.015 },
    controller.signal,
    onStart,
    onEnd,
    onLevel,
    onError,
    () => true,
  );
  expect(getUserMedia).toHaveBeenCalledWith(
    expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true }) }),
  );
  expect(applyConstraints).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  expect(options.baseAssetPath).toBe("/vad/");
  expect(options.onnxWASMBasePath).toBe("/vad/");
  expect(options.model).toBe("v5");
  const pushFrames = async (count: number, score: number) => {
    for (let i = 0; i < count; i++)
      await options.onFrameProcessed!(
        { isSpeech: score, notSpeech: 1 - score },
        new Float32Array(512).fill(0.04),
      );
  };
  await pushFrames(3, 0.95);
  await pushFrames(30, 0.02);
  expect(onStart).not.toHaveBeenCalled();
  expect(onEnd).not.toHaveBeenCalled();
  expect(onLevel).toHaveBeenLastCalledWith(0);
  await pushFrames(12, 0.95);
  await pushFrames(30, 0.02);
  expect(onStart).toHaveBeenCalledOnce();
  expect(onEnd).toHaveBeenCalledWith(expect.any(Array), 16000);
  vi.advanceTimersByTime(5000);
  expect(onError).toHaveBeenCalledWith(
    expect.stringContaining("No microphone audio received from Microphone"),
  );
  controller.abort();
  expect(stop).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(destroy).toHaveBeenCalledOnce();
  await pushFrames(12, 0.95);
  await pushFrames(30, 0.02);
  expect(onStart).toHaveBeenCalledOnce();
  expect(onEnd).toHaveBeenCalledOnce();
  track.label = "Stereo Mix";
  await expect(
    openOrbMicrophone(
      { auto_stop_on_silence: true, silence_ms: 900, speech_threshold: 0.015 },
      new AbortController().signal,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      () => true,
    ),
  ).rejects.toThrow(/computer-audio input/);
  expect(stop).toHaveBeenCalledTimes(2);

  track.label = "Microphone";
  let finishInitialization!: (vad: MicVAD) => void;
  vi.mocked(MicVAD.new).mockReturnValueOnce(
    new Promise((resolve) => {
      finishInitialization = resolve;
    }),
  );
  const cancelled = new AbortController();
  const opening = openOrbMicrophone(
    { auto_stop_on_silence: true, silence_ms: 900, speech_threshold: 0.015 },
    cancelled.signal,
    onStart,
    onEnd,
    onLevel,
    onError,
    () => true,
  );
  await vi.waitFor(() => expect(MicVAD.new).toHaveBeenCalledTimes(2));
  cancelled.abort();
  expect(stop).toHaveBeenCalledTimes(3);
  finishInitialization({ destroy } as unknown as MicVAD);
  await opening;
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  expect(destroy).toHaveBeenCalledTimes(2);
});

it("rejects sustained noise and short misfires, preserves onset, and accepts successive speech turns", async () => {
  const events: Message[] = [];
  const segments: Float32Array[] = [];
  let probability = 0.01;
  const processor = new FrameProcessor(
    async () => ({ isSpeech: probability, notSpeech: 1 - probability }),
    () => {},
    speechDetectionOptions({
      speech_threshold: 0.015,
      silence_ms: 300,
      auto_stop_on_silence: true,
    }),
    32,
  );
  const frame = new Float32Array(512).fill(0.04);
  processor.resume();
  const push = async (count: number, score: number) => {
    probability = score;
    for (let i = 0; i < count; i++)
      await processor.process(frame, (event) => {
        events.push(event.msg);
        if (event.msg === Message.SpeechEnd) segments.push(event.audio);
      });
  };
  await push(100, 0.02); // Sustained loud non-speech: the old RMS gate accepted this.
  await push(3, 0.95); // A short click-like false positive must not start a command.
  await push(12, 0.01);
  expect(events).not.toContain(Message.SpeechRealStart);
  expect(segments).toHaveLength(0);
  await push(12, 0.95);
  await push(12, 0.01);
  expect(events.filter((event) => event === Message.SpeechRealStart)).toHaveLength(1);
  expect(segments).toHaveLength(1);
  expect(segments[0].length).toBeGreaterThan(12 * 512); // Pre-speech padding retained.
  await push(12, 0.95);
  await push(12, 0.01);
  expect(segments).toHaveLength(2);
  await push(12, 0.95);
  processor.pause(() => {
    throw new Error("Stopping must discard pending speech");
  });
});

it("accepts speech immediately after playback without including the reply audio", async () => {
  const track = { label: "Microphone", stop: vi.fn(), getCapabilities: () => ({}) };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      async resume() {}
      async close() {}
    },
  );
  let options!: Partial<RealTimeVADOptions>;
  vi.mocked(MicVAD.new).mockImplementationOnce(async (value) => {
    options = value!;
    return { destroy: async () => {} } as unknown as MicVAD;
  });
  let ready = false; // Greeting / transcription / action / reply still in progress.
  const onStart = vi.fn();
  const onEnd = vi.fn();
  const controller = new AbortController();
  await openOrbMicrophone(
    { auto_stop_on_silence: true, silence_ms: 300, speech_threshold: 0.015 },
    controller.signal,
    onStart,
    onEnd,
    vi.fn(),
    vi.fn(),
    () => ready,
  );
  const push = async (count: number, score: number) => {
    for (let i = 0; i < count; i++) {
      await options.onFrameProcessed!(
        { isSpeech: score, notSpeech: 1 - score },
        new Float32Array(512).fill(ready ? 0.2 : 0.1),
      );
    }
  };
  try {
    await push(12, 0.95); // Playback is speech, but must never become a command.
    expect(onStart).not.toHaveBeenCalled();
    ready = true;
    await push(12, 0.95); // User begins immediately, with no silence between speakers.
    await push(12, 0.01);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd.mock.calls[0][0]).toHaveLength(21 * 512);
    expect(onEnd.mock.calls[0][0].every((sample: number) => sample > 0.19)).toBe(true);
    ready = false;
    await push(12, 0.95);
    ready = true;
    await push(3, 0.95); // A short acoustic tail alone must not trigger a turn.
    await push(12, 0.01);
    expect(onEnd).toHaveBeenCalledOnce();
    await push(12, 0.95);
    ready = false; // Clicking a result discards pending input.
    await push(12, 0.01);
    ready = true;
    await push(12, 0.95);
    await push(12, 0.01);
    expect(onEnd).toHaveBeenCalledTimes(2);
  } finally {
    controller.abort();
  }
});
