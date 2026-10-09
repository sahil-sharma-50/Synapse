import test from "node:test";
import assert from "node:assert/strict";
import { inspectPage, elementDetails, scrollPage } from "../page.js";
function run(elements, fn) {
  const old = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = {
    querySelectorAll: () => elements,
    createTreeWalker: () => ({ nextNode: () => null }),
    title: "Fixture",
    documentElement: {},
    body: {},
  };
  globalThis.getComputedStyle = (e) => ({
    visibility: "visible",
    display: "block",
    opacity: e.opacity ?? "1",
  });
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  try {
    return fn();
  } finally {
    Object.assign(globalThis, old);
    delete globalThis.__synapseElements;
  }
}
function element(fields = {}) {
  const e = {
    tagName: "INPUT",
    type: "text",
    innerText: "",
    name: "",
    id: "",
    autocomplete: "",
    isConnected: true,
    isContentEditable: false,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }),
    closest: () => null,
    getAttribute: () => null,
    matches: () => true,
    ...fields,
  };
  return e;
}
test("payment autocomplete is omitted and blocked even with a harmless label", () => {
  const e = element({ name: "Number", autocomplete: "cc-number" });
  run([e], () => {
    assert.equal(inspectPage().controls.length, 0);
    globalThis.__synapseElements = [e];
    assert.throws(() => elementDetails(0), /Protected/);
  });
});
test("existing editable values never become control names", () => {
  const e = element({
    tagName: "DIV",
    isContentEditable: true,
    innerText: "PRIVATE_EXISTING_VALUE",
  });
  run([e], () =>
    assert.equal(JSON.stringify(inspectPage()).includes("PRIVATE_EXISTING_VALUE"), false),
  );
});
test("opacity-hidden controls are excluded", () => {
  const e = element({ opacity: "0", name: "HIDDEN" });
  run([e], () => assert.equal(inspectPage().controls.length, 0));
});
test("visible video titles take priority over offscreen controls at the observation limit", () => {
  const hidden = Array.from({ length: 170 }, () =>
    element({
      name: "Offscreen",
      getBoundingClientRect: () => ({ x: 0, y: 2000, width: 20, height: 20 }),
    }),
  );
  const video = element({
    tagName: "A",
    innerText: "Sora memes",
    href: "https://example.com/video",
    matches: () => false,
  });
  run([...hidden, video], () => {
    document.documentElement = { clientWidth: 800, clientHeight: 600 };
    assert.equal(inspectPage().controls[0].name, "Sora memes");
    assert.equal(inspectPage().controls[0].onScreen, true);
  });
});
test("download controls cannot be acted on", () => {
  const e = element({
    tagName: "A",
    href: "https://example.com/report",
    download: "report.csv",
    hasAttribute: (n) => n === "download",
    innerText: "Report",
  });
  run([e], () => {
    assert.equal(inspectPage().controls.length, 0);
    globalThis.__synapseElements = [e];
    assert.throws(() => elementDetails(0), /Download|download/);
  });
});
test("scroll reports actual movement and page boundaries", () => {
  run([], () => {
    const target = {
      scrollTop: 0,
      scrollBy({ top }) {
        this.scrollTop = Math.max(0, Math.min(200, this.scrollTop + top));
      },
    };
    document.scrollingElement = target;
    assert.deepEqual(scrollPage(3), { scrolled: true, atBoundary: false, position: 200 });
    assert.deepEqual(scrollPage(3), { scrolled: false, atBoundary: true, position: 200 });
    assert.deepEqual(scrollPage(-3), { scrolled: true, atBoundary: false, position: 0 });
  });
});
test("active dialogs exclude background controls and inert content", () => {
  const background = element({ name: "Search" });
  const button = element({ tagName: "BUTTON", innerText: "Reject all", matches: () => false });
  const modal = element({ tagName: "DIV", querySelectorAll: () => [button] });
  button.parentElement = modal;
  run([background, button], () => {
    document.activeElement = { closest: () => modal };
    assert.deepEqual(
      inspectPage().controls.map((c) => c.name),
      ["Reject all"],
    );
    assert.equal(inspectPage().modal, true);
  });
  run([element({ inert: true })], () => assert.equal(inspectPage().controls.length, 0));
});
