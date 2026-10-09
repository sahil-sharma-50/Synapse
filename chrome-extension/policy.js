export const VERSION = 1;
export const EXTENSION_BUILD = "0.1.5";
export const COMMANDS = new Set([
  "record_targets",
  "record_start",
  "record_pause",
  "record_read",
  "record_stop",
  "resolve_recorded",
  "get_version",
  "navigate",
  "duplicate_tab",
  "begin_task",
  "observe",
  "open_url",
  "search",
  "list_tabs",
  "activate_tab",
  "close_tab",
  "click",
  "fill",
  "select",
  "scroll",
  "press_key",
  "media",
  "cancel",
  "end_task",
  "prepare",
]);
const fields = {
  record_targets: [],
  record_start: ["tab"],
  record_pause: ["paused"],
  record_read: [],
  record_stop: [],
  resolve_recorded: ["recorded"],
  navigate: ["operation"],
  duplicate_tab: [],
  get_version: [],
  begin_task: ["current"],
  observe: [],
  open_url: ["url"],
  search: ["query", "engine"],
  list_tabs: [],
  activate_tab: ["tab"],
  close_tab: ["tab"],
  click: ["element", "snapshot"],
  fill: ["element", "snapshot", "text"],
  select: ["element", "snapshot", "value"],
  scroll: ["amount"],
  press_key: ["element", "snapshot", "key"],
  media: ["operation"],
  cancel: [],
  end_task: [],
  prepare: ["command", "params"],
};
export function safeUrl(value) {
  let url;
  try {
    if (typeof value !== "string" || !value.trim()) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error("Use a complete website URL beginning with https://, or use search.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only HTTP(S) URLs without embedded credentials are supported.");
  return url.href;
}
export function searchUrl(query, engine) {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 2000 ||
    !["google", "youtube"].includes(engine)
  )
    throw new Error("Invalid search.");
  const url = new URL(
    engine === "youtube" ? "https://www.youtube.com/results" : "https://www.google.com/search",
  );
  url.searchParams.set(engine === "youtube" ? "search_query" : "q", query);
  return url.href;
}
export function validateRequest(message, generation) {
  if (
    !message ||
    message.version !== VERSION ||
    !Number.isSafeInteger(message.id) ||
    !Number.isSafeInteger(message.generation) ||
    !COMMANDS.has(message.command)
  )
    throw new Error("Invalid browser command or protocol version.");
  if (
    Object.keys(message).some(
      (key) => !["version", "id", "generation", "command", "params", "approval"].includes(key),
    )
  )
    throw new Error("Unknown message field.");
  if (generation != null && message.command !== "begin_task" && message.generation !== generation)
    throw new Error("Stale task generation.");
  const params = message.params;
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some(
      (key) =>
        !fields[message.command].includes(key) &&
        !(message.command === "begin_task" && key === "tab"),
    )
  )
    throw new Error("Invalid action parameters.");
  for (const key of fields[message.command])
    if (!(key in params)) throw new Error(`Missing ${key}.`);
  if ("paused" in params && typeof params.paused !== "boolean")
    throw new Error("Invalid recording pause flag.");
  if (
    "recorded" in params &&
    (!params.recorded ||
      typeof params.recorded !== "object" ||
      JSON.stringify(params.recorded).length > 16000)
  )
    throw new Error("Invalid recorded action.");
  if ("tab" in params && (!Number.isSafeInteger(params.tab) || params.tab < 0))
    throw new Error("Invalid tab.");
  if ("snapshot" in params && (!Number.isSafeInteger(params.snapshot) || params.snapshot < 1))
    throw new Error("Invalid snapshot.");
  if ("element" in params && (typeof params.element !== "string" || params.element.length > 100))
    throw new Error("Invalid element.");
  if ("current" in params && typeof params.current !== "boolean")
    throw new Error("Invalid current-tab flag.");
  if (message.command === "begin_task" && "tab" in params && !params.current)
    throw new Error("An existing tab cannot start a new-tab task.");
  if ("url" in params) safeUrl(params.url);
  if (message.command === "search") searchUrl(params.query, params.engine);
  if ("amount" in params && (!Number.isInteger(params.amount) || Math.abs(params.amount) > 10))
    throw new Error("Invalid scroll amount.");
  if (
    "text" in params &&
    (typeof params.text !== "string" ||
      params.text.length > 10000 ||
      /javascript:|data:/i.test(params.text))
  )
    throw new Error("Invalid field text.");
  if ("value" in params && (typeof params.value !== "string" || params.value.length > 1000))
    throw new Error("Invalid option.");
  if (
    "key" in params &&
    !["enter", "tab", "escape", "up", "down", "left", "right", "backspace"].includes(params.key)
  )
    throw new Error("Unsupported key.");
  if (
    "operation" in params &&
    !(message.command === "navigate" ? ["back", "forward", "reload"] : ["play", "pause"]).includes(
      params.operation,
    )
  )
    throw new Error("Unsupported media operation.");
  if (message.command === "prepare") {
    if (
      [
        "prepare",
        "begin_task",
        "cancel",
        "end_task",
        "record_targets",
        "record_start",
        "record_pause",
        "record_read",
        "record_stop",
        "resolve_recorded",
      ].includes(params.command)
    )
      throw new Error("Invalid review command.");
    validateRequest({ ...message, command: params.command, params: params.params }, generation);
  }
  return message;
}
export function sensitive(name) {
  return /password|passcode|credit.?card|card.?number|cvv|cvc|security.?code|one.?time|otp|payment|captcha|secret|token|(?:^|\s)cc-[\w-]+(?:\s|$)/i.test(
    name,
  );
}
export function needsApproval(command, target = {}) {
  if (command === "close_tab") return true;
  if (command === "press_key") return !target.search;
  if (command !== "click") return false;
  if (
    /\b(send|buy|purchase|pay|checkout|delete|remove|reset|publish|post|submit|grant|confirm|transfer|sign in|log in)\b/i.test(
      target.name || "",
    ) ||
    (target.submit && !target.search)
  )
    return true;
  if (target.role === "link" && target.href) {
    try {
      safeUrl(target.href);
      return false;
    } catch {
      return true;
    }
  }
  return !(
    target.search ||
    /^(play|pause|next|previous|back|close|cancel|menu|more|expand|collapse|accept all|reject all)$/i.test(
      target.name || "",
    )
  );
}
export function downloadResponse(response) {
  if (
    !response.responseStatusCode ||
    response.responseStatusCode < 200 ||
    response.responseStatusCode >= 300
  )
    return false;
  const headers = new Map(
    (response.responseHeaders || []).map((h) => [h.name.toLowerCase(), h.value.toLowerCase()]),
  );
  if (headers.get("content-disposition")?.includes("attachment")) return true;
  const mime = headers.get("content-type") || "";
  return !/^(text\/(html|plain|xml)|application\/(xhtml\+xml|xml|json)|image\/|audio\/|video\/)/.test(
    mime,
  );
}
