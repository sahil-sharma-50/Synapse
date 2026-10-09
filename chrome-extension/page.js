// Executed only from this bundled function, never from model-provided code.
export function visibleElement(e) {
  if (!e?.getClientRects().length) return false;
  const modal = document.activeElement?.closest?.('dialog,[role="dialog"],tp-yt-paper-dialog');
  let withinModal = !modal || !!e.contains?.(modal);
  for (let parent = e; parent; parent = parent.parentElement || parent.getRootNode?.().host) {
    if (parent === modal) withinModal = true;
    const style = getComputedStyle(parent);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0" ||
      parent.hidden ||
      parent.inert ||
      parent.getAttribute("aria-hidden") === "true"
    )
      return false;
  }
  return withinModal;
}
export function controlName(e) {
  const editable = e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.isContentEditable;
  return (
    e.getAttribute("aria-label") ||
    e.labels?.[0]?.innerText ||
    e.getAttribute("placeholder") ||
    (!editable ? e.innerText : "") ||
    e.getAttribute("title") ||
    e.name ||
    ""
  )
    .trim()
    .slice(0, 180);
}
export function protectedElement(e) {
  return (
    ["password", "hidden", "file"].includes(e.type) ||
    /password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|one.?time|otp|payment|captcha|secret|token|(?:^|\s)cc-[\w-]+(?:\s|$)/i.test(
      `${controlName(e)} ${e.name} ${e.id} ${e.autocomplete} ${e.type}`,
    )
  );
}
export function inspectPage() {
  const forbidden =
    /password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|one.?time|otp|payment|captcha|secret|token/i;
  const visible = visibleElement;
  const modal = document.activeElement?.closest?.('dialog,[role="dialog"],tp-yt-paper-dialog');
  const roots = [modal && visibleElement(modal) ? modal : document];
  for (let i = 0; i < roots.length; i++)
    for (const e of roots[i].querySelectorAll("*")) if (e.shadowRoot) roots.push(e.shadowRoot);
  const controls = [];
  const elements = [];
  for (const root of roots) {
    const candidates = Array.from(
      root.querySelectorAll(
        'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
      ),
      (e) => {
        const rect = e.getBoundingClientRect();
        return {
          e,
          onScreen:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.x + rect.width > 0 &&
            rect.y + rect.height > 0 &&
            rect.x < document.documentElement.clientWidth &&
            rect.y < document.documentElement.clientHeight,
        };
      },
    ).sort((a, b) => Number(b.onScreen) - Number(a.onScreen));
    for (const { e, onScreen } of candidates) {
      if (!visible(e) || controls.length >= 160) continue;
      const name = controlName(e);
      const signature = `${name} ${e.name} ${e.id} ${e.autocomplete} ${e.type}`;
      if (
        protectedElement(e) ||
        forbidden.test(signature) ||
        (e.tagName === "A" && e.hasAttribute?.("download"))
      )
        continue;
      const role =
        e.getAttribute("role") ||
        (e.tagName === "A" ? "link" : e.tagName === "BUTTON" ? "button" : e.tagName.toLowerCase());
      const form = e.form;
      const search =
        e.type === "search" ||
        form?.getAttribute("role") === "search" ||
        /search|zoeken|suche/i.test(`${name} ${form?.id || ""}`);
      const href = e.tagName === "A" ? e.href : undefined;
      const submit =
        (e.tagName === "BUTTON" && (!e.type || e.type === "submit") && !!form) ||
        e.type === "submit";
      elements.push(e);
      controls.push({
        index: elements.length - 1,
        onScreen,
        name,
        role,
        enabled: !e.disabled && e.getAttribute("aria-disabled") !== "true",
        search,
        submit,
        href,
        formAction: form?.action,
        formMethod: form?.method,
        editable: e.matches('input,textarea,[contenteditable="true"]'),
        options:
          e.tagName === "SELECT"
            ? Array.from(e.options)
                .slice(0, 50)
                .map((o) => ({ value: o.value, label: o.text }))
            : undefined,
      });
    }
  }
  // Keep references local to this isolated execution context. No field values leave Chrome.
  globalThis.__synapseElements = elements;
  const text = [];
  const walker = document.createTreeWalker(
    modal || document.body || document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  let n,
    total = 0;
  while ((n = walker.nextNode()) && total < 12000) {
    const e = n.parentElement;
    if (
      !e ||
      !visible(e) ||
      e.closest("script,style,input,textarea,select,[contenteditable],[aria-live]") ||
      forbidden.test(`${e.id} ${e.className} ${e.getAttribute("aria-label")}`)
    )
      continue;
    const value = n.textContent.trim();
    if (value) {
      text.push(value);
      total += value.length;
    }
  }
  return {
    title: document.title.slice(0, 200),
    text: text.join("\n").slice(0, 12000),
    controls,
    modal: !!modal,
  };
}

export function elementDetails(index) {
  const e = globalThis.__synapseElements?.[index];
  if (!e?.isConnected || !visibleElement(e)) throw new Error("Stale element. Observe again.");
  const forbidden =
    /password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|one.?time|otp|payment|captcha|secret|token/i;
  if (
    protectedElement(e) ||
    forbidden.test(`${e.type} ${e.name} ${e.id} ${e.autocomplete} ${e.getAttribute("aria-label")}`)
  )
    throw new Error("Protected field requires manual input.");
  if (e.tagName === "A" && e.hasAttribute?.("download"))
    throw new Error("Download links require manual handling.");
  const name = controlName(e);
  const rect = e.getBoundingClientRect();
  let hit = document.elementFromPoint?.(rect.x + rect.width / 2, rect.y + rect.height / 2);
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!next || next === hit) break;
    hit = next;
  }
  return {
    name,
    role:
      e.getAttribute("role") ||
      (e.tagName === "A" ? "link" : e.tagName === "BUTTON" ? "button" : e.tagName.toLowerCase()),
    href: e.tagName === "A" ? e.href : undefined,
    submit: (e.tagName === "BUTTON" && e.type === "submit" && !!e.form) || e.type === "submit",
    search:
      e.type === "search" ||
      e.form?.getAttribute("role") === "search" ||
      /search|zoeken|suche/i.test(`${name} ${e.form?.id || ""}`),
    enabled: !e.disabled && e.getAttribute("aria-disabled") !== "true",
    editable: e.matches('input,textarea,[contenteditable="true"]'),
    formAction: e.form?.action,
    formMethod: e.form?.method,
    hit: hit === e || !!e.contains?.(hit),
    focused: (e.getRootNode?.().activeElement || document.activeElement) === e,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  };
}

export function focusElement(index) {
  const e = globalThis.__synapseElements?.[index];
  if (!e?.isConnected) throw new Error("Stale element.");
  e.scrollIntoView({ block: "center" });
  e.focus();
}
export function verifyField(index, expected, select = false) {
  const e = globalThis.__synapseElements?.[index];
  if (!e?.isConnected) return false;
  return (select ? e.value : e.isContentEditable ? e.textContent : e.value) === expected;
}
export function selectOption(index, value) {
  const e = globalThis.__synapseElements?.[index];
  if (
    !e?.isConnected ||
    e.tagName !== "SELECT" ||
    !Array.from(e.options).some((o) => o.value === value && !o.disabled)
  )
    throw new Error("Option unavailable.");
  e.value = value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
}
export async function mediaAction(operation) {
  const video = document.querySelector("video");
  if (!video) throw new Error("No video found.");
  if (operation === "play") await video.play();
  else if (operation === "pause") video.pause();
  return { paused: video.paused, time: video.currentTime, ended: video.ended };
}

export function scrollPage(amount) {
  let target = document.scrollingElement;
  const hits =
    document.elementsFromPoint?.(
      document.documentElement.clientWidth * 0.65,
      document.documentElement.clientHeight * 0.5,
    ) || [];
  for (let e = hits[0]; e; e = e.parentElement || e.getRootNode?.().host) {
    if (
      e.scrollHeight > e.clientHeight &&
      /auto|scroll/.test(getComputedStyle(e).overflowY) &&
      visibleElement(e)
    ) {
      target = e;
      break;
    }
  }
  if (!target) throw new Error("No scrollable page is available.");
  const before = target.scrollTop;
  target.scrollBy({ top: amount * 400, behavior: "instant" });
  return {
    scrolled: target.scrollTop !== before,
    atBoundary: target.scrollTop === before,
    position: Math.round(target.scrollTop),
  };
}
