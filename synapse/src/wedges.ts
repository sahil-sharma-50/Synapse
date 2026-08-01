export type WedgeId = "stt" | "ai" | "screenshot" | "snippet" | "notepad" | "settings";

export interface WedgeDef {
  id: WedgeId;
  label: string;
  icon: string; // SVG path data, drawn in a 24x24 viewBox
}

// Order matches PRD §4.2 — a single flat ring, clockwise from the top.
export const WEDGES: WedgeDef[] = [
  {
    id: "stt",
    label: "Speech-to-Text",
    icon: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-2.07A7 7 0 0 0 19 12h-2Z",
  },
  {
    id: "ai",
    label: "AI",
    icon: "M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Zm7 11l.9 2.6L22.5 16l-2.6.9L19 19.5l-.9-2.6L15.5 16l2.6-.9L19 13ZM6 14l.9 2.1L9 17l-2.1.9L6 20l-.9-2.1L3 17l2.1-.9L6 14Z",
  },
  {
    id: "screenshot",
    label: "Screenshot",
    icon: "M9 4l-1.5 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.5L15 4H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  },
  {
    id: "snippet",
    label: "Snippet",
    icon: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 4v2h12V8H6Zm0 4v2h8v-2H6Z",
  },
  {
    id: "notepad",
    label: "Notepad",
    icon: "M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM7 12h10v1.5H7V12Zm0 4h10v1.5H7V16Z",
  },
  {
    id: "settings",
    label: "Settings",
    icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7.4 2a7.4 7.4 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.9-1.1L14.6 2H9.4L9 5.8a7.5 7.5 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.9 1.1l.4 3.8h5.2l.4-3.8a7.5 7.5 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.6c.07-.36.1-.73.1-1.1Z",
  },
];

export function wedgePath(index: number, count: number, cx: number, cy: number, rOuter: number, rInner: number): string {
  const sliceAngle = (2 * Math.PI) / count;
  const start = -Math.PI / 2 + index * sliceAngle;
  const end = start + sliceAngle;

  const p = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x1, y1] = p(rOuter, start);
  const [x2, y2] = p(rOuter, end);
  const [x3, y3] = p(rInner, end);
  const [x4, y4] = p(rInner, start);

  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 0 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

export function iconPosition(index: number, count: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const sliceAngle = (2 * Math.PI) / count;
  const mid = -Math.PI / 2 + index * sliceAngle + sliceAngle / 2;
  return { x: cx + r * Math.cos(mid), y: cy + r * Math.sin(mid) };
}
