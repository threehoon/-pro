import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export const IconDashboard = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="4.5" rx="1.5" />
    <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </svg>
);

export const IconBriefcase = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="2.5" y="7" width="19" height="13" rx="2" />
    <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" />
    <path d="M2.5 12h19" />
  </svg>
);

export const IconColumns = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="9.5" y="4" width="5" height="11" rx="1.5" />
    <rect x="16" y="4" width="5" height="14" rx="1.5" />
  </svg>
);

export const IconUsers = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17.5 14.8c2.1.5 3.5 2.1 3.5 4.2" />
  </svg>
);

export const IconCalendar = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
    <path d="M7.5 14h3M7.5 17.5h6" />
  </svg>
);

export const IconSettings = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2.2" />
    <circle cx="9" cy="17" r="2.2" />
  </svg>
);

export const IconPlus = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconSearch = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </svg>
);

export const IconX = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconChevronRight = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);

export const IconChevronLeft = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m15 5-7 7 7 7" />
  </svg>
);

export const IconChevronDown = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m5 9 7 7 7-7" />
  </svg>
);

export const IconUpload = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  </svg>
);

export const IconDownload = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 4v12M7.5 11.5 12 16l4.5-4.5" />
    <path d="M4 19h16" />
  </svg>
);

export const IconCheck = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="m4 12 5 5L20 6" />
  </svg>
);

export const IconStar = ({ filled, ...props }: IconProps & { filled?: boolean }) => (
  <svg {...base(props)} fill={filled ? "currentColor" : "none"}>
    <path d="m12 3.5 2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.8l6-.8z" />
  </svg>
);

export const IconSun = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
  </svg>
);

export const IconMoon = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);

export const IconTrash = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    <path d="M10 11v5.5M14 11v5.5" />
  </svg>
);

export const IconEdit = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m13.5 6.5 3 3" />
  </svg>
);

export const IconClock = (props: IconProps) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconMapPin = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 21s6.5-5.4 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.6 12 21 12 21Z" />
    <circle cx="12" cy="10.5" r="2.3" />
  </svg>
);

export const IconMail = (props: IconProps) => (
  <svg {...base(props)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </svg>
);

export const IconPhone = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M7 3.5h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 5 5.7 2 2 0 0 1 7 3.5Z" />
  </svg>
);

export const IconLink = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </svg>
);

export const IconArrowLeft = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M20 12H4M10 6l-6 6 6 6" />
  </svg>
);

export const IconFilter = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M3 6h18M7 12h10M10 18h4" />
  </svg>
);

export const IconAlert = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
    <path d="M12 9.5v4.5M12 17v.6" />
  </svg>
);

export const IconBell = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15L18 15.5Z" />
    <path d="M10 21h4" />
  </svg>
);

export const IconFile = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M6 3h7l5 5v13H6V3Z" />
    <path d="M13 3v5h5" />
  </svg>
);

export const IconSpark = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.2 6.2l2.6 2.6M15.2 15.2l2.6 2.6M17.8 6.2l-2.6 2.6M8.8 15.2l-2.6 2.6" />
  </svg>
);

export const IconArrowUpRight = (props: IconProps) => (
  <svg {...base(props)}>
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

