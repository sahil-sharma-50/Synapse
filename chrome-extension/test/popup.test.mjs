import test from "node:test";
import assert from "node:assert/strict";
test("missing host offers exact registration command and connected state clears recovery", async () => {
  const originalChrome = globalThis.chrome,
    originalDocument = globalThis.document;
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, textContent: "", hidden: false });
    return elements.get(id);
  };
  let changed,
    result = {
      connected: false,
      error: "Specified native messaging host not found.",
      working: false,
    };
  globalThis.document = { getElementById: get };
  globalThis.chrome = {
    runtime: { id: "jlngggffgjkkjchonkmabphikahcaepd", sendMessage: async () => result },
    storage: {
      onChanged: {
        addListener: (fn) => {
          changed = fn;
        },
      },
    },
  };
  try {
    await import("../popup.js");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get("status").textContent, "Setup needed");
    assert.equal(get("setup").hidden, false);
    assert.match(get("command").value, /-ExtensionId jlngggffgjkkjchonkmabphikahcaepd$/);
    assert.equal(get("stop").disabled, true);
    result = { connected: true, working: true, error: "" };
    changed();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(get("status").textContent, "Task running");
    assert.equal(get("setup").hidden, true);
    assert.equal(get("stop").disabled, false);
    assert.equal(get("diagnostic").hidden, true);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.document = originalDocument;
  }
});
