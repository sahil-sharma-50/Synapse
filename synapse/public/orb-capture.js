// Runs off the UI thread; forwards 20 ms mono PCM and never plays the microphone.
class OrbCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(320);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input)
      for (const sample of input) {
        this.frame[this.offset++] = sample;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(320);
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor("orb-capture", OrbCapture);
