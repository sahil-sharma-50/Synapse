import test from "node:test";
import assert from "node:assert/strict";
test("reconnect stops the existing task before replacing its native port", async () => {
  const listeners = {};
  const ports = [];
  const statuses = [];
  const timers = [];
  const originalInterval = globalThis.setInterval,
    originalChrome = globalThis.chrome;
  globalThis.setInterval = (...args) => {
    const timer = originalInterval(...args);
    timers.push(timer);
    return timer;
  };
  const event = (name) => ({
    addListener(fn) {
      listeners[name] = fn;
    },
  });
  globalThis.chrome = {
    debugger: {
      onEvent: event("debugEvent"),
      onDetach: event("detach"),
      detach: async () => {},
      attach: async () => {},
      sendCommand: async () => ({}),
    },
    tabs: { create: async () => ({ id: 1 }) },
    action: { setBadgeText: async () => {} },
    storage: { session: { set: async (v) => statuses.push(v.status) } },
    alarms: { create() {}, onAlarm: event("alarm") },
    runtime: {
      id: "extension",
      getURL: (path) => `chrome-extension://extension/${path}`,
      onStartup: event("startup"),
      onInstalled: event("installed"),
      onMessage: event("message"),
      connectNative() {
        const port = {
          messages: [],
          disconnected: false,
          onMessage: {
            addListener(fn) {
              port.receive = fn;
            },
          },
          onDisconnect: {
            addListener(fn) {
              port.disconnection = fn;
            },
          },
          postMessage(v) {
            port.messages.push(v);
          },
          disconnect() {
            port.disconnected = true;
            port.disconnection?.();
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
  try {
    await import("../background.js");
    await new Promise((resolve) => setImmediate(resolve));
    const first = ports[0];
    first.receive({ event: "connected" });
    first.receive({
      version: 1,
      id: 1,
      generation: 7,
      command: "begin_task",
      params: { current: false },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statuses.at(-1).working, true);
    listeners.message(
      { action: "reconnect" },
      { id: "extension", url: "chrome-extension://extension/popup.html" },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      first.messages.some((m) => m.event === "stopped" && m.generation === 7),
      true,
    );
    assert.equal(first.disconnected, true);
    ports[1].receive({ event: "connected" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statuses.at(-1).working, false);
  } finally {
    timers.forEach(clearInterval);
    globalThis.setInterval = originalInterval;
    globalThis.chrome = originalChrome;
  }
});
