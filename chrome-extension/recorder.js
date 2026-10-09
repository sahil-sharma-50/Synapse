import { recordingPage } from "./recorder-page.js";
import { safeUrl, sensitive } from "./policy.js";

const cleanUrl = (value) => {
  const u = new URL(safeUrl(value));
  return `${u.origin}${u.pathname}`;
};
const omittedParameters = (value) => {
  const url = new URL(value);
  return !!(url.search || url.hash);
};
export class BrowserRecorder {
  constructor(executor) {
    this.executor = executor;
    this.session = null;
    this.contexts = new Map();
    this.installing = Promise.resolve();
    this.binding = "__synapseRecordEvent";
  }
  contextKey(target, context) {
    return `${target.sessionId || "root"}:${context}`;
  }
  async targets() {
    return (await this.executor.api.tabs.query({}))
      .filter((t) => !t.incognito && /^https?:/.test(t.url || ""))
      .slice(0, 100)
      .map((t) => ({ id: String(t.id), name: (t.title || cleanUrl(t.url)).slice(0, 200) }));
  }
  async start(generation, tab) {
    await this.executor.finish();
    await this.executor.execute({
      version: 1,
      id: 0,
      generation,
      command: "begin_task",
      params: { current: true, tab },
    });
    this.executor.task.recording = true;
    const info = await this.executor.readyTab(tab, generation);
    this.session = {
      generation,
      tab,
      paused: false,
      events: [],
      count: 0,
      error: "",
      url: cleanUrl(info.url),
    };
    this.push({
      operation: "navigate",
      url: cleanUrl(info.url),
      omittedQuery: omittedParameters(info.url),
    });
    try {
      await this.executor.attach(tab, generation);
      await this.install();
      if (!this.contexts.size) throw new Error("No supported visible recording frame was found.");
      return this.read();
    } catch (error) {
      await this.executor.finish();
      throw error;
    }
  }
  push(event) {
    const session = this.session;
    if (!session || session.paused || session.error) return;
    if (session.count >= 1000) {
      session.error = "Recording reached 1,000 events. Stop and review the draft.";
      void this.pause(true);
      return;
    }
    if (JSON.stringify(event).length > 4000) {
      session.error = "A recording target exceeded the size limit.";
      return;
    }
    const last = session.events.at(-1);
    if (
      last &&
      ["fill", "select"].includes(event.operation) &&
      last.operation === event.operation &&
      JSON.stringify(last.target) === JSON.stringify(event.target)
    )
      return;
    session.events.push(event);
    session.count++;
  }
  event(source, event, params) {
    const session = this.session;
    if (!session || session.paused || source.tabId !== session.tab) return;
    if (event === "Runtime.bindingCalled" && params.name === this.binding) {
      const context = this.contexts.get(this.contextKey(source, params.executionContextId));
      if (!context || typeof params.payload !== "string" || params.payload.length > 4000) return;
      try {
        const value = JSON.parse(params.payload);
        validateRecorded(value);
        this.push({
          ...value,
          target: { ...value.target, url: session.url, frameUrl: context.url },
        });
      } catch {
        session.error = "An unsupported recording event was rejected. Review the draft.";
      }
    }
    if (
      [
        "Page.frameNavigated",
        "Page.navigatedWithinDocument",
        "Runtime.executionContextsCleared",
        "Runtime.executionContextDestroyed",
        "Target.attachedToTarget",
      ].includes(event)
    ) {
      if (event === "Runtime.executionContextDestroyed")
        this.contexts.delete(this.contextKey(source, params.executionContextId));
      if (event === "Runtime.executionContextsCleared") {
        for (const [key, context] of this.contexts)
          if (context.target.sessionId === source.sessionId) this.contexts.delete(key);
      }
      const frame = params.frame;
      if (
        !source.sessionId &&
        ((frame && !frame.parentId) ||
          (event === "Page.navigatedWithinDocument" && params.frameId === this.executor.rootFrame))
      ) {
        const raw = frame?.url || params.url;
        try {
          session.url = cleanUrl(raw);
          this.push({
            operation: "navigate",
            url: session.url,
            omittedQuery: omittedParameters(raw),
          });
        } catch {
          session.error = "Recording entered an unsupported page. Stop and review the draft.";
          void this.pause(true);
        }
      }
      this.installing = this.installing
        .catch(() => {})
        .then(() => this.install())
        .catch((error) => {
          if (this.session === session && !session.paused)
            session.error = `Recorder could not reattach: ${String(error.message).slice(0, 160)}`;
        });
    }
  }
  async install() {
    const session = this.session;
    if (!session || session.paused) return;
    const ex = this.executor;
    const targets = [
      { tabId: session.tab },
      ...[...ex.sessions.values()].filter((t) => t.tabId === session.tab),
    ];
    for (const target of targets) {
      if (this.session !== session || session.paused) return;
      if (target.sessionId) {
        await ex.guard(session.generation, () => ex.send(target, "Page.enable"));
        await ex.guard(session.generation, () => ex.send(target, "Runtime.enable"));
      }
      const { frameTree } = await ex.guard(session.generation, () =>
        ex.send(target, "Page.getFrameTree"),
      );
      if (!target.sessionId) ex.rootFrame = frameTree.frame.id;
      const visit = async (tree, parentId) => {
        if (this.session !== session || session.paused) return;
        const frame = { ...tree.frame, parentId: tree.frame.parentId || parentId };
        if (
          (/^https?:/.test(frame.url) || ["about:blank", "about:srcdoc"].includes(frame.url)) &&
          (await ex.frameVisible(target, frame, session.generation))
        ) {
          const { executionContextId } = await ex.guard(session.generation, () =>
            ex.send(target, "Page.createIsolatedWorld", {
              frameId: frame.id,
              worldName: "synapse-browser",
            }),
          );
          const key = this.contextKey(target, executionContextId);
          if (!this.contexts.has(key)) {
            if (this.contexts.size >= 100) throw new Error("Too many frames to record safely.");
            await ex.guard(session.generation, () =>
              ex.send(target, "Runtime.addBinding", { name: this.binding, executionContextId }),
            );
            if (this.session !== session || session.paused) return;
            this.contexts.set(key, {
              target,
              context: executionContextId,
              url: /^https?:/.test(frame.url) ? cleanUrl(frame.url) : frame.url,
            });
            await ex.script(
              target,
              executionContextId,
              recordingPage,
              ["install", { binding: this.binding }],
              session.generation,
            );
          }
        }
        for (const child of tree.childFrames || []) await visit(child, frame.id);
      };
      await visit(frameTree);
    }
  }
  read() {
    const s = this.session;
    if (!s) throw new Error("No recording is active.");
    return {
      events: s.events.splice(0, 40),
      paused: s.paused,
      error: s.error,
      remaining: s.events.length,
      count: s.count,
    };
  }
  async detach() {
    const ex = this.executor;
    for (const context of this.contexts.values()) {
      await ex
        .send(context.target, "Runtime.evaluate", {
          contextId: context.context,
          expression: `(${recordingPage.toString()})("stop")`,
          returnByValue: true,
        })
        .catch(() => {});
      await ex
        .send(context.target, "Runtime.removeBinding", { name: this.binding })
        .catch(() => {});
    }
    this.contexts.clear();
    const tabs = [...ex.attached];
    ex.attached.clear();
    ex.sessions.clear();
    ex.parents.clear();
    await Promise.allSettled(tabs.map((tabId) => ex.api.debugger.detach({ tabId })));
  }
  async pause(paused) {
    const s = this.session;
    if (!s) throw new Error("No recording is active.");
    s.paused = paused;
    if (paused) {
      await this.installing.catch(() => {});
      await this.detach();
    } else {
      if (s.error) {
        s.paused = true;
        throw new Error(s.error);
      }
      const info = await this.executor.readyTab(s.tab, s.generation);
      const currentUrl = cleanUrl(info.url);
      if (currentUrl !== s.url) {
        s.url = currentUrl;
        this.push({
          operation: "navigate",
          url: currentUrl,
          omittedQuery: omittedParameters(info.url),
        });
      }
      await this.executor.attach(s.tab, s.generation);
      await this.install();
    }
    return { paused: s.paused, error: s.error };
  }
  async cleanup() {
    if (this.session) this.session.paused = true;
    await this.detach();
    this.session = null;
  }
  async stop() {
    if (!this.session) throw new Error("No recording is active.");
    await this.pause(true);
    // Callers drain record_read before record_stop, preserving every buffered event.
    if (this.session.events.length > 40)
      throw new Error("Read pending recording events before stopping.");
    const result = this.read();
    await this.executor.finish();
    return result;
  }
  async resolve(recorded, generation) {
    validateRecorded(recorded);
    if (!recorded.target?.url || !recorded.target.frameUrl)
      throw new Error("Recorded target has no page scope.");
    const observation = await this.executor.observe(generation);
    if (observation.url !== recorded.target.url)
      throw new Error("The recorded page is not open. Open the exact recorded page first.");
    const { url, frameUrl, ...descriptor } = recorded.target;
    const matches = [];
    const visited = new Set();
    for (const control of this.executor.controls.values()) {
      const key = this.contextKey(control.target, control.context);
      if (visited.has(key)) continue;
      visited.add(key);
      const location = /^https?:/.test(control.url) ? cleanUrl(control.url) : control.url;
      if (location !== frameUrl) continue;
      const indices = await this.executor.script(
        control.target,
        control.context,
        recordingPage,
        ["resolve", { target: descriptor }],
        generation,
      );
      for (const index of indices) {
        for (const [element, candidate] of this.executor.controls) {
          if (
            candidate.context === control.context &&
            candidate.target.sessionId === control.target.sessionId &&
            candidate.index === index
          )
            matches.push(element);
        }
      }
    }
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? "Recorded target is ambiguous. Select a more specific target."
          : "Recorded target was not found. Repair this step.",
      );
    const params = { element: matches[0], snapshot: observation.snapshot };
    if (["fill", "select"].includes(recorded.operation)) {
      if (
        typeof recorded.textValue !== "string" ||
        !recorded.textValue ||
        recorded.textValue.includes("{{input}}")
      )
        throw new Error("Supply this recorded step's input before replay.");
      params[recorded.operation === "fill" ? "text" : "value"] = recorded.textValue;
    }
    if (recorded.operation === "press_key") params.key = recorded.key;
    return { command: recorded.operation, params };
  }
}

export function validateRecorded(value) {
  if (!value || !["click", "fill", "select", "press_key"].includes(value.operation))
    throw new Error("Unsupported recorded operation.");
  if (!value.target || typeof value.target !== "object" || Array.isArray(value.target))
    throw new Error("Invalid recorded target.");
  const allowed = [
    "tag",
    "role",
    "name",
    "id",
    "testId",
    "fieldName",
    "inputType",
    "href",
    "url",
    "frameUrl",
  ];
  if (
    Object.keys(value.target).some(
      (k) =>
        !allowed.includes(k) ||
        typeof value.target[k] !== "string" ||
        value.target[k].length > 2000,
    )
  )
    throw new Error("Invalid recorded target field.");
  if (!value.target.tag || !value.target.role || typeof value.target.name !== "string")
    throw new Error("Missing recorded target identity.");
  if (
    sensitive(Object.values(value.target).join(" ")) ||
    /authenticat|sign.?in|log.?in|2fa|security/i.test(value.target.name)
  )
    throw new Error("Protected recording target.");
  if (value.operation === "press_key" && value.key !== "enter")
    throw new Error("Unsupported recorded key.");
  if (
    value.textValue != null &&
    (typeof value.textValue !== "string" || value.textValue.length > 10000)
  )
    throw new Error("Invalid recorded input.");
  return value;
}
