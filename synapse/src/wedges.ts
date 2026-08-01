export type WedgeId = "stt" | "ai" | "screenshot" | "snippet" | "notepad" | "speak-selected" | "settings";

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
    id: "speak-selected",
    label: "Speak Selected Text",
    icon: "M3 10v4h4l5 5V5L7 10H3Zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12Zm-2.5-8.71v2.06a7 7 0 0 1 0 13.3v2.06a9 9 0 0 0 0-17.42Z",
  },
  {
    id: "settings",
    label: "Settings",
    icon: "M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.4 2.81a.49.49 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.47.41L9.25 5.35a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47-.01.59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z",
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
