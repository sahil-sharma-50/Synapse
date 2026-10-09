import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Wheel, { StatusCircle } from "./Wheel";

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

describe("wheel actions", () => {
  it("exposes every action as a keyboard-focusable button", () => {
    const markup = renderToStaticMarkup(createElement(Wheel));

    expect(markup.match(/role="button"/g)).toHaveLength(8);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(8);
    expect(markup).toContain('aria-label="Speech-to-Text"');
    expect(markup).toContain('aria-label="Force Quit"');
  });
});
