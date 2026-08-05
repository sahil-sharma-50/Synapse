import { describe, expect, it } from "vitest";
import { WEDGES, wedgePath, iconPosition } from "./wedges";

describe("WEDGES", () => {
  it("has a unique id per wedge", () => {
    const ids = WEDGES.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks only Force Quit as destructive", () => {
    expect(WEDGES.filter((w) => w.danger).map((w) => w.id)).toEqual(["quit"]);
  });

  it("gives every wedge a label and 24x24 icon path data", () => {
    for (const wedge of WEDGES) {
      expect(wedge.label.length).toBeGreaterThan(0);
      // SVG path data always starts with a moveto.
      expect(wedge.icon.startsWith("M")).toBe(true);
    }
  });
});

// cos(-PI/2) is 6.1e-17 rather than 0, so a wedge anchored at the origin
// stringifies as "5.51e-15" — the exponent has to be part of the number.
const NUMBER = String.raw`(-?[\d.]+(?:e[+-]?\d+)?)`;
const moveTo = (d: string) =>
  d.match(new RegExp(`^M ${NUMBER} ${NUMBER}`))!.slice(1).map(Number);

describe("wedgePath", () => {
  it("starts the first wedge at the top of the ring", () => {
    // Index 0 begins at -PI/2, i.e. straight up from the centre.
    const [x, y] = moveTo(wedgePath(0, 8, 100, 100, 90, 40));
    expect(x).toBeCloseTo(100, 6);
    expect(y).toBeCloseTo(10, 6);
  });

  it("closes the path and uses both radii", () => {
    const d = wedgePath(2, 8, 0, 0, 90, 40);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("A 90 90");
    expect(d).toContain("A 40 40");
  });

  it("sweeps a full circle across all wedges", () => {
    // The last wedge's outer end point must land back on the first's start.
    const start = moveTo(wedgePath(0, 8, 0, 0, 90, 40));
    const end = moveTo(wedgePath(8, 8, 0, 0, 90, 40));
    expect(end[0]).toBeCloseTo(start[0], 6);
    expect(end[1]).toBeCloseTo(start[1], 6);
  });
});

describe("iconPosition", () => {
  it("centres the icon in the wedge's angular midpoint", () => {
    // With 4 wedges, wedge 0 spans -90°..0°, so its midpoint is -45°.
    const { x, y } = iconPosition(0, 4, 0, 0, Math.SQRT2);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(-1, 6);
  });

  it("keeps the icon at the requested radius", () => {
    for (let i = 0; i < WEDGES.length; i += 1) {
      const { x, y } = iconPosition(i, WEDGES.length, 120, 120, 65);
      expect(Math.hypot(x - 120, y - 120)).toBeCloseTo(65, 6);
    }
  });
});
