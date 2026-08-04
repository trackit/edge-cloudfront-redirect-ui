/* Minimal inline SVG icon set (stroke = currentColor). Icons are added here as
   the tickets that need them land. */
type P = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconArrow = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const IconServer = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
);

export const IconSliders = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M18 18h2" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </svg>
);

export const IconBolt = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);

export const IconChevron = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const IconCheck = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const IconPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
