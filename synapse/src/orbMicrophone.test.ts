import { afterEach, expect, it, vi } from "vitest";
import { openOrbMicrophone, SpeechCapture } from "./orbMicrophone";

afterEach(() => vi.unstubAllGlobals());

it("starts capture when advertised system echo cancellation cannot be applied", async () => {
  const stop = vi.fn();
  const applyConstraints = vi
    .fn()
    .mockRejectedValue(new DOMException("Cannot satisfy constraints", "OverconstrainedError"));
  const track = {
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
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  expect(getUserMedia).toHaveBeenCalledWith(
    expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true }) }),
  );
  expect(applyConstraints).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  controller.abort();
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("ignores clicks, preserves speech onset, sends once after a pause, and accepts another turn", () => {
  let starts = 0;
  const turns: number[][] = [];
  const capture = new SpeechCapture(
    16_000,
    { speech_threshold: 0.015, silence_ms: 300, auto_stop_on_silence: true },
    () => starts++,
    (samples) => turns.push(samples),
  );
  const frame = (level: number) => capture.push(new Float32Array(320).fill(level));
  frame(0.2);
  for (let i = 0; i < 20; i++) frame(0);
  expect(starts).toBe(0);
  for (let i = 0; i < 6; i++) frame(0.1);
  expect(starts).toBe(1);
  expect(turns).toHaveLength(0);
  for (let i = 0; i < 15; i++) frame(0);
  expect(turns).toHaveLength(1);
  expect(turns[0].filter((sample) => sample > 0.09)).toHaveLength(6 * 320);
  for (let i = 0; i < 20; i++) frame(0);
  expect(turns).toHaveLength(1);
  for (let i = 0; i < 6; i++) frame(0.1);
  expect(starts).toBe(2);
});
