import { describe, expect, it } from "vitest";
// @ts-expect-error Node's types are not part of the browser app tsconfig.
import { readFileSync } from "node:fs";
import clipboardSource from "./Clipboard.tsx?raw";
import notesSource from "./NotesHub.tsx?raw";

const notesCss = readFileSync(new URL("./NotesHub.css", import.meta.url), "utf8");
const clipboardCss = readFileSync(new URL("./Clipboard.css", import.meta.url), "utf8");

describe("utility window controls", () => {
  it("draws action icons instead of using font-dependent symbols", () => {
    expect(notesSource).not.toMatch(/[★☆⌫↩×]/u);
    expect(clipboardSource).not.toMatch(/[★☆⌫↩×]/u);
  });

  it("puts keyboard focus on the search container without outlining the nested input", () => {
    expect(notesCss).toContain(".hub-search-wrap:focus-within");
    expect(notesCss).toContain(".hub-search:focus-visible");
    expect(clipboardCss).toContain(".clip-search-wrap:focus-within");
    expect(clipboardCss).toContain(".clip-search:focus-visible");
  });
});
