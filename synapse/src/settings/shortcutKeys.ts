export function shortcutFromKey(event: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null;
  let key = event.code.replace(/^(Key|Digit)/, "");
  if (/^Arrow/.test(key)) key = key.slice(5);
  if (
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/.test(
      key,
    )
  )
    return null;
  return [
    event.ctrlKey && "Control",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Super",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
