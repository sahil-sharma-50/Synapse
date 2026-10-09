import { copyFileSync, mkdirSync } from "node:fs";

// Keep speech detection offline in both Vite development and the packaged app.
const app = new URL("../synapse/", import.meta.url);
const destination = new URL("public/vad/", app);
mkdirSync(destination, { recursive: true });
for (const [pkg, files] of [
  ["@ricky0123/vad-web", ["silero_vad_v5.onnx", "vad.worklet.bundle.min.js"]],
  ["onnxruntime-web", ["ort-wasm-simd-threaded.wasm"]],
]) {
  for (const file of files) {
    copyFileSync(new URL(`node_modules/${pkg}/dist/${file}`, app), new URL(file, destination));
  }
}
