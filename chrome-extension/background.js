import { BrowserExecutor } from "./executor.js";
let port = null,
  connected = false,
  connecting = false,
  busy = false,
  lastError = "Registration missing or Synapse unavailable.",
  connectionRevision = 0;
const executor = new BrowserExecutor(chrome, (generation, error) => {
  port?.postMessage({ version: 1, event: "stopped", generation, error });
});
async function status() {
  await chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" });
  await chrome.storage.session.set({
    status: { connected, connecting, error: lastError, working: !!executor.task },
  });
}
async function connect() {
  const revision = ++connectionRevision;
  const previous = port;
  port = null;
  connected = false;
  connecting = true;
  lastError = "";
  void status();
  if (executor.task)
    previous?.postMessage({
      version: 1,
      event: "stopped",
      generation: executor.task.generation,
      error: "Connection replaced. Task stopped.",
    });
  await executor.finish();
  previous?.disconnect();
  if (revision !== connectionRevision) return;
  const current = chrome.runtime.connectNative("com.synapse.browser");
  port = current;
  current.onMessage.addListener((message) => {
    if (current !== port) return;
    if (message.event) {
      connecting = false;
      connected = message.event === "connected";
      lastError = message.error || "";
      void status();
      return;
    }
    if (message.command === "cancel" || message.command === "end_task") {
      if (executor.task && executor.task.generation !== message.generation) return;
      void executor
        .execute(message)
        .then((result) => current.postMessage({ ...message, params: undefined, ok: true, result }))
        .catch(() => {});
      return;
    }
    if (busy) {
      current.postMessage({
        version: 1,
        id: message.id,
        generation: message.generation,
        ok: false,
        error: "Browser is busy; outcome unknown.",
      });
      return;
    }
    busy = true;
    void executor
      .execute(message)
      .then((result) => {
        if (current === port)
          current.postMessage({
            version: 1,
            id: message.id,
            generation: message.generation,
            ok: true,
            result,
          });
      })
      .catch((error) => {
        if (current === port)
          current.postMessage({
            version: 1,
            id: message.id,
            generation: message.generation,
            ok: false,
            error: String(error.message).slice(0, 500),
          });
      })
      .finally(() => {
        busy = false;
        void status();
      });
  });
  current.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    if (current !== port) return;
    port = null;
    connected = false;
    connecting = false;
    lastError = lastError || reason || "Synapse disconnected.";
    void executor.finish();
    void status();
  });
}
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!port) void connect();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (message.action === "reconnect") void connect();
  if (message.action === "stop" && executor.task) {
    port?.postMessage({
      version: 1,
      event: "stopped",
      generation: executor.task.generation,
      error: "Stopped from the Chrome extension.",
    });
    void executor.finish();
  }
  reply({ connected, connecting, error: lastError, working: !!executor.task });
});
void connect();
