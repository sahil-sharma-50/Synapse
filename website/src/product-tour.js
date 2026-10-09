// Wheel paths, order, and geometry mirror synapse/src/wedges.ts; the browser guide never invokes Tauri.
const WHEEL_TOOLS = [
  {
    id: "stt",
    label: "Speech-to-Text",
    icon: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-2.07A7 7 0 0 0 19 12h-2Z",
  },
  {
    id: "ai",
    label: "AI",
    icon: "M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Zm7 11l.9 2.6L22.5 16l-2.6.9L19 19.5l-.9-2.6L15.5 16l2.6-.9L19 13ZM6 14l.9 2.1L9 17l-2.1.9L6 20l-.9-2.1L3 17l2.1-.9L6 14Z",
  },
  {
    id: "screenshot",
    label: "Screenshot",
    icon: "M9 4l-1.5 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.5L15 4H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  },
  {
    id: "clipboard",
    label: "Clipboard",
    icon: "M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1Zm1 2v1h4V4h-4ZM8 10v1.6h8V10H8Zm0 4v1.6h5.5V14H8Z",
  },
  {
    id: "notepad",
    label: "Notepad",
    icon: "M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM7 12h10v1.5H7V12Zm0 4h10v1.5H7V16Z",
  },
  {
    id: "speak-selected",
    label: "Speak Selected Text",
    icon: "M3 10v4h4l5 5V5L7 10H3Zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12Zm-2.5-8.71v2.06a7 7 0 0 1 0 13.3v2.06a9 9 0 0 0 0-17.42Z",
  },
  {
    id: "settings",
    label: "Settings",
    icon: "M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.4 2.81a.49.49 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.47.41L9.25 5.35a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47-.01.59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z",
  },
  {
    id: "quit",
    label: "Force Quit",
    icon: "M13 2h-2v10h2V2Zm4.83 2.17-1.42 1.42A7 7 0 1 1 7.6 5.58L6.17 4.17a9 9 0 1 0 10.66 0Z",
  },
];
const TOOL_GUIDES = {
  stt: {
    lead: "Speak into the app you were using. Synapse listens until you finish, then pastes the transcription back into that app.",
    steps: [
      "Place the cursor in a text field, open the wheel, and choose Speech-to-Text. You can also use Ctrl + Alt + D.",
      "Speak while the listening circle is open. Press Enter or click the circle to finish; silence does not stop dictation by default.",
      "Synapse transcribes locally, restores the previous app’s focus, and pastes the text into your field.",
    ],
    note: "Requires the optional speech model download, approximately 630 MB. This page does not record audio.",
  },
  ai: {
    lead: "Open the AI voice orb for a conversation with the provider you connect.",
    steps: [
      "Add your own Anthropic, OpenAI, or OpenRouter API key in Settings → AI.",
      "Choose AI from the wheel to open the voice orb.",
      "Your request goes to the selected provider. The reply streams back and can be spoken aloud.",
    ],
    note: "AI requires an internet connection. Provider usage is billed separately; keys are kept in the OS credential store.",
  },
  screenshot: {
    lead: "Capture the whole monitor under your cursor, then keep the image as a file and on your clipboard.",
    steps: [
      "Move your cursor onto the monitor you want to capture.",
      "Open the wheel and choose Screenshot.",
      "Synapse saves a PNG in Pictures/Synapse and copies the image to your clipboard.",
    ],
    note: "This is a monitor capture, not an area-selection editor. The browser preview cannot capture your screen.",
  },
  clipboard: {
    lead: "Find text you copied earlier, keep useful entries pinned, and paste them back into your work.",
    steps: [
      "Choose Clipboard to open the history window.",
      "Search your captured entries and pin the ones you want to keep close.",
      "Select an entry to paste into the app you were using. Manage capture, retention, and clearing in Settings → Clipboard.",
    ],
    note: "History is stored locally. This page does not read or modify your clipboard.",
  },
  notepad: {
    lead: "Open Notes Hub to keep rich notes in folders and individual sticky windows on your desktop.",
    steps: [
      "Choose Notepad from the wheel to open Notes Hub.",
      "Create or open a note, write rich text, and organize it in a folder.",
      "Open a note as a sticky when you want it beside your work.",
    ],
    note: "Notes are stored locally. Closing a sticky window does not mean deleting the note.",
  },
  "speak-selected": {
    lead: "Listen to text selected in the app you are working in.",
    steps: [
      "Select the text in another app.",
      "Open the wheel and choose Speak Selected Text.",
      "Synapse reads the selection using the optional local voice engine or the OS voice fallback.",
    ],
    note: "The website guide does not speak or access your selected text.",
  },
  settings: {
    lead: "Make the wheel fit your desktop and choose how Synapse’s tools work.",
    steps: [
      "Choose Settings from the wheel.",
      "Use Controls for shortcuts and Wheel & color for tools, accent, and size.",
      "Set up AI and voice, manage clipboard history, review usage and conversations, or check for updates.",
    ],
    note: "The screenshots below show the actual settings interface. Available colors and details can vary by app version.",
  },
  quit: {
    lead: "Exit Synapse completely, including the background app and its shortcuts.",
    steps: [
      "Open the wheel and choose Force Quit.",
      "Synapse exits immediately.",
      "Launch Synapse again when you want to use its shortcuts and tools.",
    ],
    note: "Force Quit exits Synapse itself. It does not terminate another application, and selecting it here only shows this explanation.",
  },
};
function wheelSvg(interactive) {
  const point = (r, a) => [152 + r * Math.cos(a), 152 + r * Math.sin(a)];
  const wedges = WHEEL_TOOLS.map((tool, i) => {
    const start = -Math.PI / 2 + (i * Math.PI) / 4,
      end = start + Math.PI / 4;
    const [x1, y1] = point(126, start),
      [x2, y2] = point(126, end),
      [x3, y3] = point(50, end),
      [x4, y4] = point(50, start);
    const [x, y] = point(88, start + Math.PI / 8);
    const d = `M ${x1} ${y1} A 126 126 0 0 1 ${x2} ${y2} L ${x3} ${y3} A 50 50 0 0 0 ${x4} ${y4} Z`;
    return `<g class="sy-sector" ${interactive ? `data-tool="${tool.id}" role="button" tabindex="0" aria-label="${tool.label}" aria-pressed="false"` : ""}><path class="sy-sector-face" d="${d}"/><path class="sy-sector-icon" transform="translate(${x - 10} ${y - 10}) scale(0.8333333333)" d="${tool.icon}"/></g>`;
  }).join("");
  return `<svg class="sy-real-wheel" viewBox="0 0 304 304" ${interactive ? 'role="group" aria-label="Synapse wheel feature guide"' : 'aria-hidden="true"'}>${wedges}<circle cx="152" cy="152" r="50" class="sy-hub"/><text x="152" y="150" class="sy-hub-title">Pick an action</text><text x="152" y="166" class="sy-hub-hint">DRAG TO MOVE · ESC</text><text x="152" y="175" class="sy-hub-hint">TO CLOSE</text></svg>`;
}
document.querySelectorAll("[data-wheel-art]").forEach((el) => {
  el.innerHTML = wheelSvg(false);
});
const tour = document.createElement("dialog");
tour.className = "sy-tour";
tour.setAttribute("aria-labelledby", "tour-heading");
tour.innerHTML = `<div class="sy-tour-shell"><header class="sy-tour-header"><span>Explore Synapse</span><button type="button" class="sy-close" data-close-tour>Close preview <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header><div class="sy-tour-grid"><div class="sy-wheel-column"><div id="tour-wheel">${wheelSvg(true)}</div><p class="sy-wheel-caption">The app’s eight-sector layout and icons.<br>Choose a tool to see how it works.</p></div><div class="sy-guide" aria-live="polite"><h2 id="tour-heading"></h2><p id="tour-lead"></p><ol id="tour-steps"></ol><p class="sy-tour-note" id="tour-note"></p><a href="#screenshots" class="sy-tour-link">Explore the app screenshots <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></a></div></div><p class="sy-tour-foot">Interactive feature guide. App behavior is explained here; no microphone, clipboard, AI, or desktop action is performed.</p></div>`;
document.body.append(tour);
function selectTool(id) {
  const tool = WHEEL_TOOLS.find((t) => t.id === id),
    guide = TOOL_GUIDES[id];
  tour.querySelector("#tour-heading").textContent = tool.label;
  tour.querySelector("#tour-lead").textContent = guide.lead;
  tour.querySelector("#tour-note").textContent = guide.note;
  const steps = tour.querySelector("#tour-steps");
  steps.replaceChildren();
  guide.steps.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    steps.append(li);
  });
  tour
    .querySelectorAll("[data-tool]")
    .forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.tool === id)));
}
tour.querySelectorAll("[data-tool]").forEach((el, i) => {
  el.addEventListener("click", () => selectTool(el.dataset.tool));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTool(el.dataset.tool);
    }
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const offset = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
      const next = tour.querySelectorAll("[data-tool]")[(i + offset + 8) % 8];
      next.focus();
      selectTool(next.dataset.tool);
    }
  });
});
selectTool("stt");
document.querySelectorAll("[data-open-tour]").forEach((button) =>
  button.addEventListener("click", () => {
    tour.showModal();
    tour.querySelector("[data-close-tour]").focus();
  }),
);
tour.querySelector("[data-close-tour]").addEventListener("click", () => tour.close());
tour.querySelector(".sy-tour-link").addEventListener("click", () => tour.close());
const zoom = document.createElement("dialog");
zoom.className = "sy-image-dialog";
zoom.setAttribute("aria-label", "Synapse product screenshot");
zoom.innerHTML =
  '<button type="button" class="sy-close">Close screenshot <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button><figure><img alt=""><figcaption></figcaption></figure>';
document.body.append(zoom);
zoom.querySelector("button").addEventListener("click", () => zoom.close());
document.querySelectorAll("[data-zoom]").forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const img = zoom.querySelector("img"),
      source = link.querySelector("img");
    img.src = link.href;
    img.alt = source?.alt || "Synapse app interface";
    zoom.querySelector("figcaption").textContent = source?.alt || "Synapse app interface";
    zoom.showModal();
  }),
);
