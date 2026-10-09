// Run manually after registration: node chrome-extension/test/native-smoke.mjs EXTENSION_ID
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const id = process.argv[2];
if (!/^[a-p]{32}$/.test(id || "")) throw new Error("Supply the loaded Chrome extension ID");
const crate = fileURLToPath(new URL("../../synapse/src-tauri/", import.meta.url));
const metadata = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
  cwd: crate,
  encoding: "utf8",
});
if (metadata.status !== 0) throw new Error("Cannot locate Cargo build directory");
const binary = path.join(
  JSON.parse(metadata.stdout).target_directory,
  "debug",
  "synapse-browser-host.exe",
);
const host = spawn(binary, [`chrome-extension://${id}/`]);
let data = Buffer.alloc(0);
const timer = setTimeout(() => {
  console.error("Native handshake timed out");
  host.kill();
  process.exitCode = 1;
}, 5000);
host.on("error", (error) => {
  console.error(error.message);
  clearTimeout(timer);
  process.exitCode = 1;
});
host.stdout.on("data", (chunk) => {
  data = Buffer.concat([data, chunk]);
  if (data.length < 4 || data.length < 4 + data.readUInt32LE(0)) return;
  const message = JSON.parse(data.subarray(4, 4 + data.readUInt32LE(0)));
  console.log(JSON.stringify(message));
  clearTimeout(timer);
  host.kill();
  if (message.event !== "connected") process.exitCode = 1;
});
