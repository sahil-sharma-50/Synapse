import { describe, expect, it } from "vitest";
import { shortcutFromKey } from "./shortcutKeys";

describe("shortcut recording", () => {
  const key = { code: "Enter", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
  it("records supported chords without accepting bare keys or modifiers", () => {
    expect(shortcutFromKey(key)).toBe("Control+Alt+Enter");
    expect(shortcutFromKey({ ...key, code: "KeyS", shiftKey: true })).toBe("Control+Alt+Shift+S");
    expect(shortcutFromKey({ ...key, code: "ArrowUp" })).toBe("Control+Alt+Up");
    expect(shortcutFromKey({ ...key, code: "ControlLeft" })).toBeNull();
    expect(shortcutFromKey({ ...key, ctrlKey: false, altKey: false })).toBeNull();
    expect(shortcutFromKey({ ...key, code: "F24" })).toBe("Control+Alt+F24");
  });
});
