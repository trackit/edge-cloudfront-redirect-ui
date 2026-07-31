/* Minimal inline SVG icon set (stroke = currentColor). */
type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconSearch = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" />
  </svg>
);
export const IconPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconEdit = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
export const IconTrash = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
);
export const IconChevron = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const IconClose = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
export const IconCheck = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
export const IconArrow = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconClock = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const IconInfo = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
export const IconBolt = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);
export const IconGlobe = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
  </svg>
);
export const IconServer = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
);
export const IconShield = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3Z" />
  </svg>
);
export const IconGit = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8.5v7M18 11.5c0 3-3 3.5-6 3.5" />
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
export const IconGrip = ({ size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </svg>
);
