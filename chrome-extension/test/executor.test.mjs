import test from "node:test";
import assert from "node:assert/strict";
import { BrowserExecutor } from "../executor.js";
import { readFile } from "node:fs/promises";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  const event = () => ({
    addListener(fn) {
      this.listener = fn;
    },
  });
  const calls = [];
  const api = {
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (t, m, p) => {
        calls.push(m);
        if (m === "Page.getFrameTree")
          return { frameTree: { frame: { id: "root", url: "https://example.com/" } } };
        if (m === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (m === "Runtime.evaluate")
          return { result: { value: { scrolled: true, atBoundary: false } } };
        return {};
      },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://example.com/", title: "Example" }),
      create: async () => ({ id: 1 }),
      query: async () => [],
      update: async () => {},
      remove: async () => {},
    },
    windows: { update: async () => {} },
  };
  const executor = new BrowserExecutor(api);
  clearInterval(executor.watchdog);
  return { api, executor, calls };
}
const request = (command, params = {}, id = 1) => ({
  version: 1,
  id,
  generation: 7,
  command,
  params,
});
test("page exceptions preserve the stale-reference recovery message without a CDP stack", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  api.debugger.sendCommand = async () => ({
    exceptionDetails: {
      exception: {
        description:
          "Error: Stale element. Observe again.\n    at elementDetails (<anonymous>:1:20)",
      },
    },
  });
  await assert.rejects(
    executor.script({ tabId: 1 }, 1, () => {}),
    { message: "Stale element. Observe again." },
  );
});
test("unrelated iframe and execution-context churn preserves root controls", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  executor.attached.add(1);
  executor.rootFrame = "root";
  executor.snapshot = 4;
  executor.controls.set("root-control", { target: { tabId: 1 }, context: 7, frame: "root" });
  const emit = (event, params) => api.debugger.onEvent.listener({ tabId: 1 }, event, params);
  emit("Runtime.executionContextDestroyed", { executionContextId: 99 });
  emit("Page.frameNavigated", { frame: { id: "ad", parentId: "root" } });
  emit("Target.detachedFromTarget", { sessionId: "ad-session" });
  assert.equal(executor.snapshot, 4);
  assert.equal(executor.controls.has("root-control"), true);
  emit("Page.navigatedWithinDocument", { frameId: "root" });
  assert.equal(executor.controls.size, 0);
  assert.equal(executor.snapshot, 5);
});
test("destroyed frame controls expire without invalidating other frames", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  executor.attached.add(1);
  executor.snapshot = 4;
  executor.controls.set("root", { target: { tabId: 1 }, context: 7, frame: "root" });
  executor.controls.set("child", { target: { tabId: 1 }, context: 9, frame: "child" });
  api.debugger.onEvent.listener({ tabId: 1 }, "Runtime.executionContextDestroyed", {
    executionContextId: 9,
  });
  assert.equal(executor.controls.has("root"), true);
  assert.equal(executor.controls.has("child"), false);
  assert.equal(executor.snapshot, 4);
});
test("changed labels refresh safely while protected fields remain blocked", async () => {
  const { executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  executor.snapshot = 1;
  executor.controls.set("a", {
    index: 0,
    name: "search_query",
    tab: 1,
    target: { tabId: 1 },
    context: 1,
  });
  executor.script = async () => ({ name: "Search", enabled: true });
  await assert.rejects(
    executor.execute(
      request("prepare", { command: "fill", params: { element: "a", snapshot: 1, text: "music" } }),
    ),
    /Stale element/,
  );
  executor.script = async () => ({ name: "Password", enabled: true });
  await assert.rejects(
    executor.execute(
      request("prepare", { command: "fill", params: { element: "a", snapshot: 1, text: "music" } }),
    ),
    /Protected/,
  );
});
test("history navigation dispatches only the allowed operation and duplicate selects its new tab", async () => {
  const { api, executor } = fixture();
  let back = 0,
    detached;
  api.tabs.goBack = async () => {
    back++;
  };
  api.tabs.duplicate = async (id) => {
    assert.equal(id, 1);
    return { id: 2 };
  };
  api.debugger.detach = async ({ tabId }) => {
    detached = tabId;
  };
  await executor.execute(request("begin_task", { current: false }));
  const result = await executor.execute(request("navigate", { operation: "back" }));
  assert.equal(back, 1);
  assert.equal(result.navigated, true);
  await assert.rejects(
    executor.execute(request("navigate", { operation: "evaluate" })),
    /Unsupported/,
  );
  const duplicated = await executor.execute(request("duplicate_tab"));
  assert.equal(duplicated.tab, 2);
  assert.equal(executor.task.tab, 2);
  assert.equal(detached, 1);
  assert.equal(executor.attached.has(1), false);
});
test("committed URL is usable while ads keep the tab loading", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  let reads = 0;
  api.tabs.get = async (id) => ({
    id,
    url: "https://example.com/",
    status: ++reads === 1 ? "loading" : "complete",
  });
  await executor.readyTab(1, 7);
  assert.equal(reads, 1);
});
test("version preflight works before a task and matches the installed manifest", async () => {
  const { executor } = fixture();
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal((await executor.execute(request("get_version"))).build, manifest.version);
  assert.equal(executor.task, null);
});
test("new navigation uses one blank tab and intercepts downloads before loading the requested site", async () => {
  const { api, executor, calls } = fixture();
  let url = "about:blank",
    created;
  api.tabs.create = async (params) => {
    created = params;
    return { id: 1 };
  };
  api.tabs.get = async (id) => ({ id, url, status: "loading" });
  api.tabs.update = async (id, params) => {
    calls.push("navigate");
    url = params.url;
  };
  await executor.execute(request("begin_task", { current: false }));
  const result = await executor.execute(request("open_url", { url: "https://www.youtube.com/" }));
  assert.equal(created.url, "about:blank");
  assert.ok(calls.indexOf("Fetch.enable") < calls.indexOf("navigate"));
  assert.equal(result.url, "https://www.youtube.com/");
  await executor.finish();
  api.tabs.query = async () => [{ id: 1, url: "about:blank" }];
  url = "about:blank";
  await assert.rejects(executor.execute(request("begin_task", { current: true })), /HTTP/);
});
test("scroll follow-up reuses the previous task tab without creating or navigating a tab", async () => {
  const { api, executor, calls } = fixture();
  let created = 0,
    active = 2;
  api.tabs.create = async () => {
    created++;
    return { id: 1 };
  };
  api.tabs.query = async () => [{ id: active, url: "https://unrelated.example/" }];
  api.tabs.get = async (id) => ({ id, url: "https://www.youtube.com/", status: "complete" });
  await executor.execute(request("begin_task", { current: false }));
  await executor.finish();
  await executor.execute({ ...request("begin_task", { current: true, tab: 1 }), generation: 8 });
  await executor.execute({ ...request("scroll", { amount: 3 }), generation: 8 });
  assert.equal(created, 1);
  assert.equal(executor.task.tab, 1);
  assert.ok(calls.includes("Runtime.evaluate"));
});
test("YouTube opens in a new task tab even when the first navigation is pending", async () => {
  const { api, executor } = fixture();
  let created,
    navigated,
    reads = 0;
  api.tabs.create = async (params) => {
    created = params;
    return { id: 1 };
  };
  api.tabs.get = async (id) =>
    ++reads === 1
      ? { id, url: "", pendingUrl: "https://www.google.com/", status: "loading" }
      : { id, url: navigated || "https://www.google.com/", status: "complete" };
  api.tabs.update = async (id, params) => {
    assert.equal(id, 1);
    navigated = params.url;
  };
  await executor.execute(request("begin_task", { current: false }));
  const result = await executor.execute(request("open_url", { url: "https://www.youtube.com/" }));
  assert.equal(created.active, true);
  assert.equal(navigated, "https://www.youtube.com/");
  assert.equal(result.navigated, true);
  assert.equal(result.url, "https://www.youtube.com/");
});
test("attachment waits for a new tab's pending URL to commit", async () => {
  const { api, executor, calls } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  let reads = 0;
  api.tabs.get = async (id) =>
    ++reads === 1
      ? { id, url: "", pendingUrl: "https://example.com/", status: "loading" }
      : { id, url: "https://example.com/", status: "complete" };
  await executor.execute(request("scroll", { amount: 1 }));
  assert.ok(reads >= 2);
  assert.ok(calls.includes("Runtime.evaluate"));
});
test("stop interrupts a loading tab before any browser input", async () => {
  const { api, executor, calls } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  const entered = deferred();
  api.tabs.get = async (id) => {
    entered.resolve();
    return { id, url: "", pendingUrl: "https://example.com/", status: "loading" };
  };
  const action = executor.execute(request("scroll", { amount: 1 }));
  await entered.promise;
  await executor.execute(request("cancel", {}, 2));
  await assert.rejects(action, /stopped|generation/i);
  assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
});
test("malformed link metadata cannot discard observed page controls", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  api.debugger.sendCommand = async (target, method) => {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "root", url: "https://example.com/" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    return {};
  };
  executor.script = async () => ({
    text: "Example",
    controls: [{ index: 0, name: "Example", role: "link", href: "http://[" }],
  });
  const observation = await executor.observe(7);
  assert.equal(observation.controls.length, 1);
  assert.equal(observation.controls[0].href, undefined);
});
test("cancel during tab creation cannot resurrect a task", async () => {
  const { api, executor } = fixture();
  const gate = deferred();
  api.tabs.create = () => gate.promise;
  const begin = executor.execute(request("begin_task", { current: false }));
  await executor.execute(request("cancel", {}, 2));
  gate.resolve({ id: 1 });
  await assert.rejects(begin, /stopped|generation/i);
  assert.equal(executor.task, null);
});
test("cancel during attachment detaches and performs no scrolling", async () => {
  const { api, executor, calls } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  const gate = deferred(),
    entered = deferred();
  let detached = false;
  api.debugger.attach = () => {
    entered.resolve();
    return gate.promise;
  };
  api.debugger.detach = async () => {
    detached = true;
  };
  const scroll = executor.execute(request("scroll", { amount: 1 }));
  await entered.promise;
  await executor.execute(request("cancel", {}, 2));
  gate.resolve();
  await assert.rejects(scroll, /stopped|generation/i);
  assert.equal(detached, true);
  assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
});
test("a focus handler cannot change an approved click target", async () => {
  const { executor, calls } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  executor.snapshot = 1;
  executor.controls.set("a", {
    index: 0,
    name: "Search",
    href: undefined,
    tab: 1,
    target: { tabId: 1 },
    context: 1,
    frame: "root",
    root: "root",
  });
  let focused = false;
  executor.script = async (t, c, fn) => {
    if (fn.name === "focusElement") {
      focused = true;
      return;
    }
    if (fn.name === "elementDetails")
      return {
        name: focused ? "Buy" : "Search",
        role: "button",
        search: !focused,
        enabled: true,
        x: 1,
        y: 1,
      };
  };
  await assert.rejects(
    executor.execute(request("click", { element: "a", snapshot: 1 })),
    /changed|protected|target|stale/i,
  );
  assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
});
test("close approval expires if the reviewed tab navigates", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  executor.task.allowedTabs.add(2);
  let url = "https://example.com/";
  let removed = false;
  api.tabs.get = async (id) => ({ id, url, title: "Example" });
  api.tabs.remove = async () => {
    removed = true;
  };
  const review = await executor.execute(
    request("prepare", { command: "close_tab", params: { tab: 2 } }),
  );
  url = "https://example.com/new";
  await assert.rejects(
    executor.execute({ ...request("close_tab", { tab: 2 }), approval: review.reviewId }),
    /confirmation|changed/i,
  );
  assert.equal(removed, false);
});
test("hidden iframe contents are never observed, inherited visible frames are supported", async () => {
  const { api, executor } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  api.debugger.sendCommand = async (t, m, p) => {
    if (m === "Page.getFrameTree")
      return {
        frameTree: {
          frame: { id: "root", url: "https://example.com/" },
          childFrames: [
            { frame: { id: "hidden", parentId: "root", url: "https://example.com/hidden" } },
            { frame: { id: "visible", parentId: "root", url: "about:srcdoc" } },
          ],
        },
      };
    if (m === "Page.createIsolatedWorld") return { executionContextId: p.frameId };
    if (m === "DOM.getFrameOwner") return { backendNodeId: p.frameId };
    if (m === "DOM.resolveNode") return { object: { objectId: p.backendNodeId } };
    if (m === "Runtime.callFunctionOn") return { result: { value: p.objectId !== "hidden" } };
    return {};
  };
  executor.script = async (t, c) => ({
    text: c === "hidden" ? "HIDDEN_SECRET" : c === "visible" ? "VISIBLE_FRAME" : "Root",
    controls: [],
  });
  const observation = await executor.observe(7);
  assert.equal(observation.text.includes("HIDDEN_SECRET"), false);
  assert.equal(observation.text.includes("VISIBLE_FRAME"), true);
});
test("cancellation during first input event prevents later input events", async () => {
  const { api, executor, calls } = fixture();
  await executor.execute(request("begin_task", { current: false }));
  executor.snapshot = 1;
  executor.controls.set("a", {
    index: 0,
    name: "Name",
    tab: 1,
    target: { tabId: 1 },
    context: 1,
    frame: "root",
    root: "root",
  });
  executor.script = async (t, c, fn) =>
    fn.name === "elementDetails"
      ? { name: "Name", role: "input", editable: true, focused: true, enabled: true }
      : undefined;
  const gate = deferred(),
    entered = deferred();
  api.debugger.sendCommand = async (t, m) => {
    calls.push(m);
    if (m === "Input.dispatchKeyEvent") {
      entered.resolve();
      await gate.promise;
    }
    return {};
  };
  const fill = executor.execute(request("fill", { element: "a", snapshot: 1, text: "Hello" }));
  await entered.promise;
  await executor.execute(request("cancel", {}, 2));
  gate.resolve();
  await assert.rejects(fill, /stopped|generation/i);
  assert.equal(calls.includes("Input.insertText"), false);
  assert.equal(calls.filter((m) => m === "Input.dispatchKeyEvent").length, 1);
});
