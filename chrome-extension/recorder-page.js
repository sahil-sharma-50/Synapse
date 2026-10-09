import { visibleElement, protectedElement, controlName } from "./page.js";

// This bundled function runs in an isolated world. It never reads field values.
export function recordingPage(mode, options = {}) {
  const key = "__synapseRecording";
  const url = () => `${location.origin}${location.pathname}`;
  const describe = (e) => {
    if (!e || !visibleElement(e) || protectedElement(e)) return null;
    if (
      /(?:^|\/)(?:login|signin|sign-in|authenticate|authentication|oauth|checkout|payment)(?:\/|$)/i.test(
        location.pathname,
      )
    )
      return null;
    const form = e.form;
    if (
      form &&
      (form.querySelector?.(
        'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]',
      ) ||
        /authenticat|sign.?in|log.?in|checkout|payment/i.test(
          `${form.id} ${form.getAttribute?.("action")}`,
        ))
    )
      return null;
    const editable = e.matches("input,textarea,select,[contenteditable]");
    const name = editable
      ? (e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.name || e.id || "")
          .trim()
          .slice(0, 180)
      : controlName(e);
    if (
      /authenticat|sign.?in|log.?in|2fa|security|payment|password|captcha/i.test(
        `${name} ${e.id} ${e.name} ${e.autocomplete}`,
      )
    )
      return null;
    if (e.tagName === "A" && e.hasAttribute("download")) return null;
    const target = {
      tag: e.tagName.toLowerCase(),
      role:
        e.getAttribute("role") ||
        (e.tagName === "A" ? "link" : e.tagName === "BUTTON" ? "button" : e.tagName.toLowerCase()),
      name,
      id: (e.id || "").slice(0, 180),
      testId: (e.getAttribute("data-testid") || "").slice(0, 180),
      fieldName: (e.getAttribute("name") || "").slice(0, 180),
      inputType: (e.type || "").slice(0, 40),
    };
    if (!target.id && !target.testId && !target.fieldName && !target.name) return null;
    if (e.tagName === "A") {
      try {
        const href = new URL(e.href);
        if (!/^https?:$/.test(href.protocol) || href.username || href.password) return null;
        target.href = `${href.origin}${href.pathname}`;
      } catch {
        return null;
      }
    }
    return target;
  };
  if (mode === "describe") return describe(globalThis.__synapseElements?.[options.index]);
  if (mode === "resolve") {
    const wanted = options.target;
    const matches = [];
    for (let index = 0; index < (globalThis.__synapseElements || []).length; index++) {
      const actual = describe(globalThis.__synapseElements[index]);
      if (actual && Object.keys(wanted).every((key) => actual[key] === wanted[key]))
        matches.push(index);
    }
    return matches;
  }
  globalThis[key]?.stop();
  if (mode === "stop") return true;
  if (mode !== "install") throw new Error("Invalid recording operation.");
  const controller = new AbortController();
  const dirty = new WeakSet();
  const emit = (operation, e, extra = {}) => {
    const target = describe(e);
    if (!target) return;
    const message = { operation, target, frameUrl: url(), ...extra };
    globalThis[options.binding](JSON.stringify(message));
  };
  const listener = (event) => {
    if (!event.isTrusted) return;
    const first = event.composedPath()[0];
    const e = first?.closest?.(
      'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
    );
    if (!e) return;
    if (event.type === "input") {
      // One placeholder per edit gesture; no .value, textContent, or selected option is read.
      if (!dirty.has(e)) {
        dirty.add(e);
        emit(e.tagName === "SELECT" ? "select" : "fill", e, { textValue: "{{input}}" });
      }
    } else if (event.type === "focusout") dirty.delete(e);
    else if (event.type === "change" && e.tagName === "SELECT" && !dirty.has(e)) {
      dirty.add(e);
      emit("select", e, { textValue: "{{input}}" });
    } else if (
      event.type === "keydown" &&
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      emit("press_key", e, { key: "enter" });
    } else if (
      event.type === "click" &&
      !e.matches(
        'input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable]',
      )
    )
      emit("click", e);
  };
  for (const event of ["click", "input", "change", "focusout", "keydown"])
    document.addEventListener(event, listener, { capture: true, signal: controller.signal });
  globalThis[key] = {
    stop: () => {
      controller.abort();
      delete globalThis[key];
    },
  };
  return true;
}
