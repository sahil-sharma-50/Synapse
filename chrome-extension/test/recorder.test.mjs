import test from "node:test";
import assert from "node:assert/strict";
import { recordingPage } from "../recorder-page.js";
import { BrowserRecorder, validateRecorded } from "../recorder.js";

function pageFixture(run) {
  const previous = new Map(
    [
      "document",
      "location",
      "getComputedStyle",
      "__synapseRecordEvent",
      "__synapseRecording",
      "__synapseElements",
    ].map((key) => [key, globalThis[key]]),
  );
  const listeners = new Map(),
    events = [];
  globalThis.document = {
    activeElement: null,
    addEventListener(type, listener, { signal }) {
      listeners.set(type, (event) => {
        if (!signal.aborted) listener(event);
      });
    },
  };
  globalThis.location = { origin: "https://example.com", pathname: "/form" };
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
  globalThis.__synapseRecordEvent = (value) => events.push(JSON.parse(value));
  const field = (fields = {}) => ({
    tagName: "INPUT",
    type: "text",
    id: "query",
    name: "query",
    autocomplete: "",
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute: (key) => (key === "aria-label" ? "Search" : null),
    getRootNode: () => ({}),
    closest() {
      return this;
    },
    matches: () => true,
    get value() {
      throw new Error("Recorder read private value");
    },
    ...fields,
  });
  const dispatch = (type, element, extra = {}) =>
    listeners.get(type)?.({ type, isTrusted: true, composedPath: () => [element], ...extra });
  try {
    run({ events, field, dispatch });
  } finally {
    globalThis.__synapseRecording?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}
test("recording never reads input values, excludes protected fields, and removes listeners", () => {
  pageFixture(({ events, field, dispatch }) => {
    recordingPage("install", { binding: "__synapseRecordEvent" });
    const input = field();
    dispatch("input", input);
    dispatch("input", input);
    dispatch("input", field({ type: "password" }));
    dispatch("input", field({ autocomplete: "cc-number" }));
    dispatch("input", field({ id: "authentication-code" }));
    dispatch("input", field(), { isTrusted: false });
    assert.equal(events.length, 1);
    assert.equal(events[0].textValue, "{{input}}");
    assert.equal(events[0].target.id, "query");
    assert.equal("snapshot" in events[0], false);
    recordingPage("stop");
    dispatch("input", field());
    assert.equal(events.length, 1);
  });
});
test("stable descriptors resolve replacement controls and fail ambiguous identities", () => {
  pageFixture(({ field }) => {
    globalThis.__synapseElements = [field()];
    const descriptor = recordingPage("describe", { index: 0 });
    globalThis.__synapseElements = [field({ id: "unrelated" }), field()];
    assert.deepEqual(recordingPage("resolve", { target: descriptor }), [1]);
    globalThis.__synapseElements.push(field());
    assert.deepEqual(recordingPage("resolve", { target: descriptor }), [1, 2]);
  });
});
test("authentication forms and authentication pages are excluded without reading values", () => {
  pageFixture(({ events, field, dispatch }) => {
    recordingPage("install", { binding: "__synapseRecordEvent" });
    dispatch(
      "input",
      field({ form: { querySelector: () => ({ type: "password" }), getAttribute: () => null } }),
    );
    globalThis.location.pathname = "/account/login";
    dispatch("input", field());
    assert.deepEqual(events, []);
  });
});
test("recorded payload rejects protected or unsupported target/action fields", () => {
  const value = {
    operation: "click",
    target: { tag: "button", role: "button", name: "Continue", id: "continue" },
  };
  assert.equal(validateRecorded(value), value);
  assert.throws(() => validateRecorded({ ...value, operation: "evaluate" }), /Unsupported/);
  assert.throws(
    () => validateRecorded({ ...value, target: { ...value.target, name: "Password" } }),
    /Protected/,
  );
  assert.throws(
    () => validateRecorded({ ...value, target: { ...value.target, selector: "*" } }),
    /Invalid/,
  );
});
function recorderFixture() {
  const installed = [],
    detached = [];
  let context = 1;
  const ex = {
    task: { generation: 7, tab: 1 },
    sessions: new Map(),
    parents: new Map(),
    attached: new Set([1]),
    api: { debugger: { detach: async (target) => detached.push(target.tabId) } },
    guard: async (_generation, fn) => fn(),
    send: async (_target, method) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "root", url: "https://example.com/form" } } }
        : method === "Page.createIsolatedWorld"
          ? { executionContextId: context }
          : {},
    script: async (_target, _context, _fn, args) => {
      installed.push(args[0]);
      return true;
    },
    frameVisible: async () => true,
    readyTab: async () => ({ id: 1, url: "https://example.com/form" }),
    attach: async () => ex.attached.add(1),
  };
  const recorder = new BrowserRecorder(ex);
  recorder.session = {
    generation: 7,
    tab: 1,
    paused: false,
    events: [],
    count: 0,
    error: "",
    url: "https://example.com/form",
  };
  return {
    recorder,
    ex,
    installed,
    detached,
    setContext: (value) => {
      context = value;
    },
  };
}
test("navigation reinstalls recording and pause detaches without collecting unrelated events", async () => {
  const { recorder, ex, installed, detached, setContext } = recorderFixture();
  await recorder.install();
  assert.deepEqual(installed, ["install"]);
  setContext(2);
  recorder.event({ tabId: 1 }, "Runtime.executionContextsCleared", {});
  await recorder.installing;
  assert.deepEqual(installed, ["install", "install"]);
  const payload = JSON.stringify({
    operation: "click",
    target: { tag: "button", role: "button", name: "Next" },
    frameUrl: "https://example.com/form",
  });
  recorder.event({ tabId: 2 }, "Runtime.bindingCalled", {
    name: recorder.binding,
    executionContextId: 2,
    payload,
  });
  assert.equal(recorder.read().events.length, 0);
  await recorder.pause(true);
  recorder.event({ tabId: 1 }, "Runtime.bindingCalled", {
    name: recorder.binding,
    executionContextId: 2,
    payload,
  });
  assert.deepEqual(detached, [1]);
  assert.equal(recorder.read().events.length, 0);
  setContext(3);
  await recorder.pause(false);
  assert.equal(ex.attached.has(1), true);
  recorder.event({ tabId: 1 }, "Runtime.bindingCalled", {
    name: recorder.binding,
    executionContextId: 3,
    payload,
  });
  assert.equal(recorder.read().events[0].target.url, "https://example.com/form");
  await recorder.cleanup();
  assert.equal(recorder.session, null);
  assert.equal(recorder.contexts.size, 0);
});
test("replay requires one fresh target and refuses unfilled input placeholders", async () => {
  const { recorder, ex } = recorderFixture();
  const control = { target: { tabId: 1 }, context: 5, index: 4, url: "https://example.com/form" };
  ex.controls = new Map([["19:0", control]]);
  ex.observe = async () => ({ url: "https://example.com/form", snapshot: 19 });
  ex.script = async () => [4];
  const recorded = {
    operation: "click",
    target: {
      tag: "button",
      role: "button",
      name: "Continue",
      url: "https://example.com/form",
      frameUrl: "https://example.com/form",
    },
  };
  assert.deepEqual(await recorder.resolve(recorded, 7), {
    command: "click",
    params: { element: "19:0", snapshot: 19 },
  });
  await assert.rejects(
    recorder.resolve({ ...recorded, operation: "fill", textValue: "{{input}}" }, 7),
    /Supply/,
  );
  ex.controls.set("19:1", { ...control });
  await assert.rejects(recorder.resolve(recorded, 7), /ambiguous/);
});
test("omitted hash routes are marked for repair instead of silently replaying the base URL", async () => {
  const { recorder } = recorderFixture();
  recorder.event({ tabId: 1 }, "Page.frameNavigated", {
    frame: { id: "root", url: "https://example.com/form#private-route" },
  });
  await recorder.installing;
  const [event] = recorder.read().events;
  assert.equal(event.url, "https://example.com/form");
  assert.equal(event.omittedQuery, true);
});
