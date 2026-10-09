import { describe, expect, it } from "vitest";
import {
  duplicateWorkflow,
  newStep,
  newWorkflow,
  runIsActive,
  splitLines,
  selectNoteSource,
  type WorkflowRun,
} from "./workflowModel";

describe("workflow editor", () => {
  it("duplicates as a separate unapproved routine without competing aliases", () => {
    const original = {
      ...newWorkflow(),
      id: "saved-routine",
      revision: 3,
      approved_revision: 3,
      aliases: ["start workspace"],
      steps: [newStep("draft")],
    };
    const copy = duplicateWorkflow(original);
    expect(newWorkflow().id).toBe("");
    expect(copy.id).toBe("");
    expect(copy.id).not.toBe(original.id);
    expect(copy.steps[0].id).not.toBe(original.steps[0].id);
    expect(copy.revision).toBe(0);
    expect(copy.approved_revision).toBeNull();
    expect(copy.aliases).toEqual([]);
    copy.steps[0].sources?.push("new source");
    expect(original.steps[0].sources).toEqual([]);
  });
  it("normalizes multiline source names and marks approval waits active", () => {
    expect(splitLines(" alpha\r\n\n beta \nalpha")).toEqual(["alpha", "beta"]);
    expect(runIsActive({ status: "awaiting_approval" } as WorkflowRun)).toBe(true);
    expect(runIsActive({ status: "failed" } as WorkflowRun)).toBe(false);
  });
  it("creates a folder action without command or executable fields", () => {
    const step = newStep("open_path");
    expect(step.path).toBe("");
    expect(step.label).toBe("Open project folder");
    expect(step.command).toBeUndefined();
    expect(step.app).toBeUndefined();
  });
  it("selects note sources without replacing existing draft sources or duplicating notes", () => {
    expect(selectNoteSource(newStep("collect"), "selected-note")).toEqual({
      instruction: "note:selected-note",
    });
    const step = { ...newStep("draft"), sources: ["board", "note:selected-note", ""] };
    expect(selectNoteSource(step, "selected-note")).toEqual({
      sources: ["board", "note:selected-note"],
    });
    expect(selectNoteSource(step, "")).toEqual({});
    expect(selectNoteSource(newStep("command"), "selected-note")).toEqual({});
  });
});
