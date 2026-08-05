import { describe, expect, it } from "vitest";
import { NOTE_COLORS } from "./noteColors";

// The Rust/TS parity check lives in scripts/guards/note-colors.mjs — it needs to
// read a .rs file, which is outside what a unit test should be doing. This file
// only covers the shape of the TS list itself.
describe("NOTE_COLORS", () => {
  it("has unique ids", () => {
    const ids = NOTE_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every colour a human label", () => {
    for (const colour of NOTE_COLORS) {
      expect(colour.label.length).toBeGreaterThan(0);
      expect(colour.id).toMatch(/^[a-z]+$/);
    }
  });

  it("keeps the backend default first", () => {
    // notes.rs uses COLORS[0] as the default colour for a new note.
    expect(NOTE_COLORS[0].id).toBe("amber");
  });
});
