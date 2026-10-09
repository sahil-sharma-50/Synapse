import { describe, expect, it } from "vitest";
import { reduceDesktopContext, type DesktopContextEvent } from "./desktopChoices";

const event: DesktopContextEvent = {
  session: 2,
  turn: 3,
  generation: 4,
  app: "Explorer",
  title: "Documents",
  question: "Choose a file",
  choices: {
    id: "set",
    items: [{ id: "one", name: "Budget.xlsx", kind: "file", location: "Documents" }],
  },
  partial: false,
  scope: ["Documents"],
};

describe("desktop choices", () => {
  it("keeps current choices when a previous session or turn emits late", () => {
    const current = { session: 2, turn: 3, context: event };
    expect(reduceDesktopContext(current, { ...event, session: 1 })).toBe(current);
    expect(reduceDesktopContext(current, { ...event, turn: 2 })).toBe(current);
    expect(reduceDesktopContext(current, { ...event, turn: 4 })).toBe(current);
  });
  it("clears choices only when the matching task explicitly clears them", () => {
    const current = { session: 2, turn: 3, context: event };
    expect(reduceDesktopContext(current, { ...event, choices: null }).context?.choices).toBeNull();
    expect(current.context.choices?.items).toHaveLength(1);
  });
});
