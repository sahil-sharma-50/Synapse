import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StatusCircle } from "./Wheel";

describe("selected-text speech controls", () => {
  it("renders an explicit button that lets the user stop speaking", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusCircle, {
        title: "Speaking…",
        actionLabel: "Stop speaking",
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("<button");
    expect(markup).toContain(">Stop speaking</button>");
  });
});
