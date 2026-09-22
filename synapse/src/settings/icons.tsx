// Minimal stroke-based icons, sized via CSS (`.set-nav-icon svg`, `.set-row-icon svg`)
// and colored via `currentColor` so they follow active/hover state automatically.

const common = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SparkleIcon() {
  return (
    <svg {...common}>
      <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z" />
      <path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg {...common}>
      <path d="M20 6v4h-4" />
      <path d="M20 10a8 8 0 10-1.5 5.8" />
      <path d="M16 20v-4h4" />
    </svg>
  );
}

export function SpeakerIcon() {
  return (
    <svg {...common}>
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" />
      <path d="M15.5 9.5a3.5 3.5 0 010 5" />
      <path d="M18 7a7 7 0 010 10" />
    </svg>
  );
}

export function ControlsIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M4 7h3m4 0h9M4 17h9m4 0h3" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </svg>
  );
}

export function ColorPickerIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="m14 5 5 5M16 7l3-3a2.1 2.1 0 0 1 3 3l-3 3M15 6 4 17v3h3L18 9" />
    </svg>
  );
}

export function LineChartIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M4 4v16h16M7 15l4-5 4 3 5-7" />
    </svg>
  );
}

export function ChatIcon() {
  return (
    <svg {...common} aria-hidden="true">
      <path d="M20 11.5a8 8 0 0 1-8 8H4l1.5-4a8 8 0 1 1 14.5-4Z" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg {...common}>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="M10.6 13L19 4.5" />
      <path d="M16.2 7.3l2.3 2.3" />
      <path d="M13.6 10l2.3 2.3" />
    </svg>
  );
}

export function ChipIcon() {
  return (
    <svg {...common}>
      <rect x="7" y="7" width="10" height="10" rx="2.5" />
      <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
    </svg>
  );
}

export function LayersIcon() {
  return (
    <svg {...common}>
      <path d="M12 4l8 4-8 4-8-4 8-4z" />
      <path d="M4 12.5l8 4 8-4" />
      <path d="M4 16.5l8 4 8-4" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg {...common}>
      <rect x="9.25" y="3" width="5.5" height="10" rx="2.75" />
      <path d="M5.5 11a6.5 6.5 0 0013 0" />
      <path d="M12 17.5V21" />
    </svg>
  );
}

export function WaveIcon() {
  return (
    <svg {...common}>
      <path d="M3 12h2M8 7v10M12 4.5v15M16 8.5v7M21 12h-2" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.2" />
    </svg>
  );
}

export function ClipboardIcon() {
  return (
    <svg {...common}>
      <path d="M9 4.5h6a1 1 0 011 1V7H8V5.5a1 1 0 011-1z" />
      <path d="M8 6H6.5A1.5 1.5 0 005 7.5v11A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5v-11A1.5 1.5 0 0017.5 6H16" />
    </svg>
  );
}

export function NoteIcon() {
  return (
    <svg {...common}>
      <path d="M5 5.5A1.5 1.5 0 016.5 4h11A1.5 1.5 0 0119 5.5V14l-5 5H6.5A1.5 1.5 0 015 17.5v-12z" />
      <path d="M19 14h-3.5a1.5 1.5 0 00-1.5 1.5V19" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...common}>
      <path d="M5 7h14" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0111 4h2a1.5 1.5 0 011.5 1.5V7" />
      <path d="M6.5 7l.8 11.1A1.5 1.5 0 008.8 19.5h6.4a1.5 1.5 0 001.5-1.4L17.5 7" />
    </svg>
  );
}
