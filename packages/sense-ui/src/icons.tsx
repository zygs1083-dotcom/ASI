/** 统一风格的描边 SVG 图标（stroke=currentColor，不用 emoji）。 */

interface IconProps {
  size?: number;
  className?: string;
}

function base(props: IconProps) {
  return {
    width: props.size ?? 13,
    height: props.size ?? 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: props.className,
  };
}

export function PulseIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />
    </svg>
  );
}

export function CpuIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
    </svg>
  );
}

export function MemoryIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <rect x="1.5" y="5" width="13" height="6" rx="1" />
      <path d="M4.5 5v6M8 5v6M11.5 5v6" />
    </svg>
  );
}

export function DiskIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M2 10.5 4.3 4.2A1.5 1.5 0 0 1 5.7 3h4.6a1.5 1.5 0 0 1 1.4 1.2L14 10.5" />
      <rect x="2" y="10.5" width="12" height="2.5" rx="1" />
      <path d="M11 11.75h1" />
    </svg>
  );
}

export function BatteryIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <rect x="1.5" y="5" width="11" height="6" rx="1.5" />
      <path d="M14.5 7v2M8.6 6 7 8.2h2L7.4 10" />
    </svg>
  );
}

export function ThermalIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M6 9.3V3a2 2 0 1 1 4 0v6.3a3.2 3.2 0 1 1-4 0Z" />
      <path d="M8 5.5V10" />
    </svg>
  );
}

export function NetworkIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M8 12.5a1 1 0 1 0 0 .01" />
      <path d="M4.5 9.5a5 5 0 0 1 7 0M2 7a9 9 0 0 1 12 0" />
    </svg>
  );
}

export function ProcessIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5 6.5 8 4.5 9.5M8.5 9.5h3" />
    </svg>
  );
}

export function TokenIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v6M5.5 8h5" />
    </svg>
  );
}

export function ShieldIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M8 1.8 13 3.8v3.7c0 3-2 5.4-5 6.7-3-1.3-5-3.7-5-6.7V3.8L8 1.8Z" />
      <path d="m5.8 7.8 1.6 1.6 3-3" />
    </svg>
  );
}

export function WarnIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M8 2 14.5 13h-13L8 2Z" />
      <path d="M8 6.5v3M8 11v.01" />
    </svg>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v3.4M8 4.8v.01" />
    </svg>
  );
}

export function AppIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="M6 10.5 8 5.5l2 5M6.7 9h2.6" />
    </svg>
  );
}

export function ThumbUpIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M5 7v6H2.5V7H5Zm0 0 3-4.5c.9 0 1.6.7 1.4 1.7L9 6.5h3.4a1.5 1.5 0 0 1 1.4 2l-1.4 4a1.5 1.5 0 0 1-1.4 1H5" />
    </svg>
  );
}

export function ThumbDownIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M11 9V3h2.5v6H11Zm0 0-3 4.5c-.9 0-1.6-.7-1.4-1.7L7 9.5H3.6a1.5 1.5 0 0 1-1.4-2l1.4-4a1.5 1.5 0 0 1 1.4-1H11" />
    </svg>
  );
}

export function PauseIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </svg>
  );
}

export function EyeOffIcon(p: IconProps) {
  return (
    <svg {...base(p)} aria-hidden="true">
      <path d="M3 3l10 10" />
      <path d="M6.6 6.7a2 2 0 0 0 2.7 2.7M4.2 4.5C2.9 5.4 2 6.6 1.6 8c.9 2.5 3.4 4.5 6.4 4.5 1 0 2-.3 2.8-.7M6.9 3.7 8 3.6c3 0 5.5 2 6.4 4.4-.3.8-.8 1.5-1.5 2.2" />
    </svg>
  );
}
