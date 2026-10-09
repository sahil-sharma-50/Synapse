import {
  validateRequest,
  EXTENSION_BUILD,
  safeUrl,
  searchUrl,
  needsApproval,
  sensitive,
  downloadResponse,
} from "./policy.js";
import {
  inspectPage,
  elementDetails,
  focusElement,
  verifyField,
  selectOption,
  mediaAction,
  scrollPage,
  visibleElement,
  controlName,
  protectedElement,
} from "./page.js";
import { BrowserRecorder } from "./recorder.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visibleUrl = (value) => {
  try {
    const url = new URL(safeUrl(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
};
export class BrowserExecutor {
  constructor(api, onStop = () => {}) {
    this.api = api;
    this.onStop = onStop;
    this.task = null;
    this.snapshot = 0;
    this.controls = new Map();
    this.sessions = new Map();
    this.parents = new Map();
    this.attached = new Set();
    this.reviews = new Map();
    this.recorder = new BrowserRecorder(this);
    api.debugger.onEvent.addListener((source, event, params) => {
      if (!this.attached.has(source.tabId)) return;
      this.recorder.event(source, event, params);
      if (event === "Fetch.requestPaused") {
        const generation = this.task?.generation;
        const blocked = downloadResponse(params);
        void this.guard(generation, () =>
          this.send(
            source,
            blocked ? "Fetch.failRequest" : "Fetch.continueRequest",
            blocked
              ? { requestId: params.requestId, errorReason: "BlockedByClient" }
              : { requestId: params.requestId },
          ),
        )
          .then(() => {
            if (blocked) {
              this.onStop(generation, "Downloads require manual handling.");
              return this.finish();
            }
          })
          .catch(() => {});
      }
      if (event === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
        const target = { tabId: source.tabId, sessionId: params.sessionId };
        this.sessions.set(params.sessionId, target);
        this.parents.set(params.sessionId, source);
        void this.send(target, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        }).catch(() => {});
      }
      const frame = params.frame?.id || params.frameId;
      const rootNavigation =
        ["Page.frameNavigated", "Page.navigatedWithinDocument"].includes(event) &&
        !source.sessionId &&
        (frame === this.rootFrame || (event === "Page.frameNavigated" && !params.frame.parentId));
      if (rootNavigation || (event === "Runtime.executionContextsCleared" && !source.sessionId)) {
        this.snapshot++;
        this.controls.clear();
        this.reviews.clear();
      } else {
        for (const [element, control] of this.controls) {
          const sameTarget = control.target.sessionId === source.sessionId;
          if (
            (sameTarget &&
              [
                "Page.frameNavigated",
                "Page.navigatedWithinDocument",
                "Page.frameDetached",
              ].includes(event) &&
              frame &&
              control.frame === frame) ||
            (sameTarget &&
              event === "Runtime.executionContextDestroyed" &&
              control.context === params.executionContextId) ||
            (sameTarget && event === "Runtime.executionContextsCleared") ||
            (event === "Target.detachedFromTarget" && control.target.sessionId === params.sessionId)
          ) {
            this.controls.delete(element);
          }
        }
        for (const [id, review] of this.reviews) {
          const element = JSON.parse(review.params).element;
          if (element && !this.controls.has(element)) this.reviews.delete(id);
        }
      }
      if (event === "Target.detachedFromTarget") {
        this.sessions.delete(params.sessionId);
        this.parents.delete(params.sessionId);
      }
    });
    api.debugger.onDetach.addListener((source) => {
      if (this.attached.delete(source.tabId) && this.task) {
        this.task.cancelled = true;
        this.onStop(this.task.generation, "Chrome debugger detached. Task stopped.");
        void this.finish();
      }
    });
    this.watchdog = setInterval(() => {
      if (this.task && Date.now() - this.task.lastCommand > 60000) {
        this.onStop(this.task.generation, "Browser task connection timed out.");
        void this.finish();
      }
    }, 5000);
  }
  check(generation) {
    if (!this.task || this.task.cancelled || this.task.generation !== generation)
      throw new Error("Task stopped or generation changed.");
    this.task.lastCommand = Date.now();
  }
  async guard(generation, operation) {
    this.check(generation);
    const result = await operation();
    this.check(generation);
    return result;
  }
  send(target, method, params = {}) {
    return this.api.debugger.sendCommand(target, method, params);
  }
  async script(target, context, fn, args = [], generation = this.task?.generation) {
    const result = await this.guard(generation, () =>
      this.send(target, "Runtime.evaluate", {
        contextId: context,
        expression: `(()=>{const visibleElement=(${visibleElement.toString()});const controlName=(${controlName.toString()});const protectedElement=(${protectedElement.toString()});return (${fn.toString()})(...${JSON.stringify(args)});})()`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
    );
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Page operation failed.";
      throw new Error(description.split("\n")[0].replace(/^Error: /, ""));
    }
    return result.result?.value;
  }
  async readyTab(tab, generation) {
    for (let i = 0; i < 50; i++) {
      const info = await this.guard(generation, () => this.api.tabs.get(tab));
      if (info.url && !info.pendingUrl) {
        if (!(info.url === "about:blank" && this.task.initialBlank && this.task.tab === tab))
          safeUrl(info.url);
        return info;
      }
      await delay(100);
    }
    throw new Error(
      "Page is still loading; outcome unknown. Wait for it to load and start a new request.",
    );
  }
  async attach(tab, generation) {
    const info = await this.readyTab(tab, generation);
    if (info.incognito) throw new Error("Incognito is not supported.");
    if (!this.attached.has(tab)) {
      this.check(generation);
      await this.api.debugger.attach({ tabId: tab }, "1.3");
      try {
        this.check(generation);
      } catch (error) {
        await this.api.debugger.detach({ tabId: tab }).catch(() => {});
        throw error;
      }
      this.attached.add(tab);
      await this.guard(generation, () => this.send({ tabId: tab }, "Page.enable"));
      await this.guard(generation, () => this.send({ tabId: tab }, "Runtime.enable"));
      if (!this.task.recording)
        await this.guard(generation, () =>
          this.send({ tabId: tab }, "Fetch.enable", {
            patterns: [{ resourceType: "Document", requestStage: "Response" }],
          }),
        );
      await this.guard(generation, () =>
        this.send({ tabId: tab }, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        }),
      );
    }
  }
  async finish() {
    if (this.task) this.task.cancelled = true;
    if (this.recorder.session) await this.recorder.cleanup();
    if (this.task) this.task.cancelled = true;
    this.task = null;
    const attached = [...this.attached];
    this.attached.clear();
    this.controls.clear();
    this.reviews.clear();
    this.sessions.clear();
    this.parents.clear();
    this.rootFrame = null;
    await Promise.allSettled(attached.map((tabId) => this.api.debugger.detach({ tabId })));
  }
  async observe(generation) {
    // Only the currently selected task tab is read.
    this.check(generation);
    const tab = this.task.tab;
    await this.attach(tab, generation);
    const snapshot = ++this.snapshot;
    this.controls.clear();
    this.reviews.clear();
    const pages = [],
      controls = [];
    const targets = [{ tabId: tab }, ...[...this.sessions.values()].filter((t) => t.tabId === tab)];
    for (const target of targets) {
      const { frameTree } = await this.guard(generation, () =>
        this.send(target, "Page.getFrameTree"),
      );
      if (!target.sessionId) this.rootFrame = frameTree.frame.id;
      const frames = [];
      const collect = (tree, parentId) => {
        frames.push({ ...tree.frame, parentId: tree.frame.parentId || parentId });
        for (const child of tree.childFrames || []) collect(child, tree.frame.id);
      };
      collect(frameTree);
      for (const frame of frames) {
        this.check(generation);
        if (!/^https?:/.test(frame.url) && !["about:srcdoc", "about:blank"].includes(frame.url))
          continue;
        try {
          if (!(await this.frameVisible(target, frame, generation))) continue;
          const { executionContextId: context } = await this.guard(generation, () =>
            this.send(target, "Page.createIsolatedWorld", {
              frameId: frame.id,
              worldName: "synapse-browser",
            }),
          );
          const page = await this.script(target, context, inspectPage, [], generation);
          // Limit across frames as well as within each page.
          pages.push(page.text.slice(0, Math.max(0, 12000 - pages.join("\n").length)));
          for (const control of page.controls) {
            if (controls.length >= 160) break;
            const element = `${snapshot}:${controls.length}`;
            this.controls.set(element, {
              ...control,
              target,
              context,
              frame: frame.id,
              frameInfo: frame,
              root: frameTree.frame.id,
              tab,
              url: frame.url,
            });
            controls.push({
              ...control,
              href: control.href ? visibleUrl(control.href) : undefined,
              formAction: control.formAction ? visibleUrl(control.formAction) : undefined,
              index: undefined,
              element,
              frame: frame.id,
            });
          }
        } catch (error) {
          pages.push(`Frame unavailable: ${String(error.message).slice(0, 120)}`);
        }
      }
    }
    const info = await this.readyTab(tab, generation);
    this.check(generation);
    if (snapshot !== this.snapshot)
      throw new Error("Page changed during observation. Observe again.");
    return {
      tab,
      title: info.title?.slice(0, 200),
      url: visibleUrl(info.url),
      snapshot,
      text: pages.join("\n").slice(0, 12000),
      controls,
    };
  }
  async selectTab(tab, generation) {
    const target = await this.readyTab(tab, generation);
    await this.guard(generation, () => this.api.tabs.update(tab, { active: true }));
    await this.guard(generation, () => this.api.windows.update(target.windowId, { focused: true }));
    const old = this.task.tab;
    this.task.tab = tab;
    this.snapshot++;
    this.controls.clear();
    this.reviews.clear();
    this.rootFrame = null;
    this.task.initialBlank = false;
    if (old !== tab && this.attached.delete(old)) {
      this.sessions.clear();
      this.parents.clear();
      await this.guard(generation, () => this.api.debugger.detach({ tabId: old }).catch(() => {}));
    }
    return target;
  }
  async frameVisible(target, frame, generation, focused = false) {
    if (!frame.parentId) return !target.sessionId;
    let ownerTarget = target;
    const { frameTree } = await this.guard(generation, () =>
      this.send(target, "Page.getFrameTree"),
    );
    if (frame.id === frameTree.frame.id && target.sessionId)
      ownerTarget = this.parents.get(target.sessionId);
    if (!ownerTarget) return false;
    const { backendNodeId } = await this.guard(generation, () =>
      this.send(ownerTarget, "DOM.getFrameOwner", { frameId: frame.id }),
    );
    const { executionContextId } = await this.guard(generation, () =>
      this.send(ownerTarget, "Page.createIsolatedWorld", {
        frameId: frame.parentId,
        worldName: "synapse-browser",
      }),
    );
    const { object } = await this.guard(generation, () =>
      this.send(ownerTarget, "DOM.resolveNode", { backendNodeId, executionContextId }),
    );
    const result = await this.guard(generation, () =>
      this.send(ownerTarget, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(){return (${visibleElement.toString()})(this) && (${focused ? "this.ownerDocument.activeElement === this" : "true"});}`,
        returnByValue: true,
      }),
    );
    if (result.exceptionDetails || result.result?.value !== true) return false;
    const parentTree = await this.guard(generation, () =>
      this.send(ownerTarget, "Page.getFrameTree"),
    );
    let parent;
    const find = (tree, parentId) => {
      if (tree.frame.id === frame.parentId)
        parent = { ...tree.frame, parentId: tree.frame.parentId || parentId };
      for (const child of tree.childFrames || []) find(child, tree.frame.id);
    };
    find(parentTree.frameTree);
    return !!parent && this.frameVisible(ownerTarget, parent, generation, focused);
  }
  async target(params, generation) {
    this.check(generation);
    const control = this.controls.get(params.element);
    if (params.snapshot !== this.snapshot || !control || control.tab !== this.task.tab)
      throw new Error("Stale element. Observe again.");
    const details = await this.script(
      control.target,
      control.context,
      elementDetails,
      [control.index],
      generation,
    );
    if (sensitive(details.name)) throw new Error("Protected field requires manual input.");
    if (!details.enabled || details.name !== control.name || details.href !== control.href)
      throw new Error("Stale element. Observe again.");
    this.check(generation);
    return { control, details };
  }
  async describe(command, params, generation) {
    let details = {},
      description = command.replaceAll("_", " ");
    if (params.element) {
      ({ details } = await this.target(params, generation));
      description = `${description}: ${details.name || details.role}`;
      if (["fill", "press_key"].includes(command) && !details.editable && command === "fill")
        throw new Error("Target is not an editable field.");
      if (command === "click" && details.href && !/^https?:/.test(details.href))
        throw new Error("Protected link requires manual handling.");
    }
    if (command === "open_url") description = `Open ${visibleUrl(params.url)}`;
    if (command === "search") description = `Search ${params.engine}`;
    if (command === "close_tab") {
      if (!this.task.allowedTabs.has(params.tab))
        throw new Error("List tabs before choosing a tab.");
      const tab = await this.guard(generation, () => this.api.tabs.get(params.tab));
      description = `Close tab: ${tab.title}`;
      details = { tab: tab.id, url: tab.url, title: tab.title };
    }
    const signature = { ...details };
    for (const key of ["x", "y", "viewportWidth", "viewportHeight", "hit", "focused"])
      delete signature[key];
    return { details: signature, description, reviewRequired: needsApproval(command, details) };
  }
  async execute(message) {
    validateRequest(
      message,
      ["record_start", "record_targets"].includes(message.command)
        ? undefined
        : this.task?.generation,
    );
    const { generation, command, params } = message;
    if (command === "get_version") return { build: EXTENSION_BUILD };
    if (command === "cancel" || command === "end_task") {
      await this.finish();
      return { stopped: true };
    }
    if (command === "record_targets") return { targets: await this.recorder.targets() };
    if (command === "record_start") return this.recorder.start(generation, params.tab);
    if (command === "record_pause") {
      this.check(generation);
      return this.recorder.pause(params.paused);
    }
    if (command === "record_read") {
      this.check(generation);
      return this.recorder.read();
    }
    if (command === "record_stop") {
      this.check(generation);
      return this.recorder.stop();
    }
    if (this.recorder.session) throw new Error("Stop recording before running browser actions.");
    if (command === "begin_task") {
      if (this.task) throw new Error("Another browser task is active.");
      this.task = {
        generation,
        tab: null,
        cancelled: false,
        lastCommand: Date.now(),
        allowedTabs: new Set(),
        initialBlank: !params.current,
      };
      let tab;
      if (params.current) {
        if (params.tab != null) tab = await this.readyTab(params.tab, generation);
        else
          [tab] = await this.guard(generation, () =>
            this.api.tabs.query({ active: true, lastFocusedWindow: true }),
          );
        if (!tab || tab.incognito) throw new Error("No ordinary Chrome tab is available.");
        await this.readyTab(tab.id, generation);
        if (params.tab != null) {
          await this.guard(generation, () => this.api.tabs.update(tab.id, { active: true }));
          await this.guard(generation, () =>
            this.api.windows.update(tab.windowId, { focused: true }),
          );
        }
      } else
        tab = await this.guard(generation, () =>
          this.api.tabs.create({ url: "about:blank", active: true }),
        );
      this.check(generation);
      this.task.tab = tab.id;
      this.task.allowedTabs.add(tab.id);
      return { tab: tab.id, started: true };
    }
    this.check(generation);
    const send = (target, method, params) =>
      this.guard(generation, () => this.send(target, method, params));
    const script = (target, context, fn, args) =>
      this.script(target, context, fn, args, generation);
    if (command === "observe") return this.observe(generation);
    if (command === "resolve_recorded") return this.recorder.resolve(params.recorded, generation);
    if (command === "prepare") {
      const review = await this.describe(params.command, params.params, generation);
      const reviewId = crypto.randomUUID();
      this.reviews.clear();
      this.reviews.set(reviewId, {
        command: params.command,
        params: JSON.stringify(params.params),
        snapshot: this.snapshot,
        details: JSON.stringify(review.details),
        tab: this.task.tab,
      });
      return { description: review.description, reviewRequired: review.reviewRequired, reviewId };
    }
    const review = await this.describe(command, params, generation);
    if (review.reviewRequired) {
      const approval = this.reviews.get(message.approval);
      if (
        !approval ||
        approval.command !== command ||
        approval.params !== JSON.stringify(params) ||
        approval.snapshot !== this.snapshot ||
        approval.tab !== this.task.tab ||
        approval.details !== JSON.stringify(review.details)
      )
        throw new Error("Action requires a fresh confirmation.");
      this.reviews.delete(message.approval);
    }
    this.check(generation);
    const tab = this.task.tab;
    if (command === "list_tabs") {
      const tabs = (await this.guard(generation, () => this.api.tabs.query({}))).filter(
        (t) => !t.incognito && /^https?:/.test(t.url || ""),
      );
      this.task.allowedTabs = new Set(tabs.map((t) => t.id));
      return {
        tabs: tabs.map((t) => ({
          tab: t.id,
          title: t.title?.slice(0, 200),
          url: visibleUrl(t.url),
        })),
      };
    }
    if (command === "activate_tab") {
      if (!this.task.allowedTabs.has(params.tab))
        throw new Error("List tabs before choosing a tab.");
      await this.selectTab(params.tab, generation);
      return { tab: params.tab, activated: true };
    }
    if (command === "duplicate_tab") {
      const duplicated = await this.guard(generation, () => this.api.tabs.duplicate(tab));
      this.task.allowedTabs.add(duplicated.id);
      await this.selectTab(duplicated.id, generation);
      return { tab: duplicated.id, duplicated: true };
    }
    if (command === "close_tab") {
      await this.guard(generation, () => this.api.tabs.remove(params.tab));
      if (params.tab === tab) {
        await this.finish();
        return { closed: true, taskEnded: true };
      }
      return { closed: true };
    }
    if (command === "open_url" || command === "search") {
      await this.attach(tab, generation);
      const url =
        command === "search" ? searchUrl(params.query, params.engine) : safeUrl(params.url);
      await this.guard(generation, () => this.api.tabs.update(tab, { url }));
      this.task.initialBlank = false;
      this.snapshot++;
      this.controls.clear();
      const info = await this.readyTab(tab, generation);
      return { navigated: true, url: visibleUrl(info.url) };
    }
    await this.attach(tab, generation);
    if (command === "navigate") {
      const operation =
        params.operation === "back"
          ? "goBack"
          : params.operation === "forward"
            ? "goForward"
            : "reload";
      await this.guard(generation, () => this.api.tabs[operation](tab));
      this.snapshot++;
      this.controls.clear();
      this.reviews.clear();
      const info = await this.readyTab(tab, generation);
      return { navigated: true, operation: params.operation, url: visibleUrl(info.url) };
    }
    if (command === "scroll") {
      const { frameTree } = await send({ tabId: tab }, "Page.getFrameTree");
      const { executionContextId: context } = await send(
        { tabId: tab },
        "Page.createIsolatedWorld",
        { frameId: frameTree.frame.id, worldName: "synapse-browser" },
      );
      return await script({ tabId: tab }, context, scrollPage, [params.amount]);
    }
    if (command === "media") {
      const { frameTree } = await send({ tabId: tab }, "Page.getFrameTree");
      const { executionContextId: context } = await send(
        { tabId: tab },
        "Page.createIsolatedWorld",
        { frameId: frameTree.frame.id, worldName: "synapse-browser" },
      );
      const first = await script({ tabId: tab }, context, mediaAction, [params.operation]);
      await delay(600);
      this.check(generation);
      const second = await script({ tabId: tab }, context, mediaAction, ["status"]);
      if (params.operation === "play" && (second.paused || second.time <= first.time))
        throw new Error("Playback did not advance. The player may require manual interaction.");
      if (params.operation === "pause" && !second.paused)
        throw new Error("Playback did not pause.");
      return { verified: true, paused: second.paused };
    }
    const { control, details } = await this.target(params, generation);
    await script(control.target, control.context, focusElement, [control.index]);
    this.check(generation);
    const refreshed = await this.target(params, generation);
    for (const key of [
      "name",
      "role",
      "href",
      "search",
      "submit",
      "editable",
      "formAction",
      "formMethod",
    ]) {
      if (refreshed.details[key] !== details[key])
        throw new Error("Target changed during focus. Observe again.");
    }
    if (command === "click" && !refreshed.details.hit)
      throw new Error("Target is covered by another element. Handle manually.");
    if (command !== "click" && !refreshed.details.focused)
      throw new Error("Focus moved to another field. Handle manually.");
    if (
      control.frameInfo &&
      !(await this.frameVisible(control.target, control.frameInfo, generation, command !== "click"))
    )
      throw new Error("Frame is hidden or focus moved. Handle manually.");
    if (command === "click") {
      const position = refreshed.details;
      let x = position.x,
        y = position.y;
      // ponytail: frame input works; nested/OOP frame clicks need live coordinate validation before enabling.
      if (
        control.target.sessionId ||
        (control.frame !== control.root && control.frameInfo?.parentId !== control.root)
      )
        throw new Error("This frame click requires manual handling.");
      if (control.frame !== control.root) {
        const { backendNodeId } = await send(control.target, "DOM.getFrameOwner", {
          frameId: control.frame,
        });
        const { model } = await send(control.target, "DOM.getBoxModel", { backendNodeId });
        if (model.content[1] !== model.content[3] || model.content[0] !== model.content[6])
          throw new Error("Transformed frame requires manual handling.");
        x =
          model.content[0] +
          (position.x * (model.content[2] - model.content[0])) / position.viewportWidth;
        y =
          model.content[1] +
          (position.y * (model.content[7] - model.content[1])) / position.viewportHeight;
        const { executionContextId } = await send(control.target, "Page.createIsolatedWorld", {
          frameId: control.root,
          worldName: "synapse-browser",
        });
        const { object } = await send(control.target, "DOM.resolveNode", {
          backendNodeId,
          executionContextId,
        });
        const hit = await send(control.target, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration:
            "function(x,y){return this.ownerDocument.elementFromPoint(x,y) === this;}",
          arguments: [{ value: x }, { value: y }],
          returnByValue: true,
        });
        if (hit.result?.value !== true)
          throw new Error("Frame target is covered. Handle manually.");
      }
      await send(control.target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await send(control.target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await delay(200);
      return { executed: true, verifyByObservation: true };
    }
    if (command === "fill") {
      if (!details.editable) throw new Error("Not an editable field.");
      await send(control.target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await send(control.target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      const focused = await this.target(params, generation);
      if (!focused.details.focused)
        throw new Error("Focus moved to another field. Handle manually.");
      if (
        control.frameInfo &&
        !(await this.frameVisible(control.target, control.frameInfo, generation, true))
      )
        throw new Error("Frame focus moved. Handle manually.");
      await send(control.target, "Input.insertText", { text: params.text });
      const verified = await script(control.target, control.context, verifyField, [
        control.index,
        params.text,
      ]);
      if (!verified) throw new Error("Field value did not match the requested text.");
      return { verified: true };
    }
    if (command === "select") {
      await script(control.target, control.context, selectOption, [control.index, params.value]);
      if (
        !(await script(control.target, control.context, verifyField, [
          control.index,
          params.value,
          true,
        ]))
      )
        throw new Error("Selection failed.");
      return { verified: true };
    }
    if (command === "press_key") {
      const keys = {
        enter: ["Enter", 13],
        tab: ["Tab", 9],
        escape: ["Escape", 27],
        up: ["ArrowUp", 38],
        down: ["ArrowDown", 40],
        left: ["ArrowLeft", 37],
        right: ["ArrowRight", 39],
        backspace: ["Backspace", 8],
      };
      const [key, code] = keys[params.key];
      await send(control.target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        windowsVirtualKeyCode: code,
      });
      await send(control.target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        windowsVirtualKeyCode: code,
      });
      return { executed: true, verifyByObservation: true };
    }
    throw new Error("Unsupported command.");
  }
}
