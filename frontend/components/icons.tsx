import type { ReactNode } from 'react';

/** 16px stroke icons (decorative: always aria-hidden; the label next to them carries the meaning). */
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

export const Icons = {
  dashboard: <Svg><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>,
  exchange: <Svg><path d="M7 4 3 8l4 4" /><path d="M3 8h14" /><path d="m17 12 4 4-4 4" /><path d="M21 16H7" /></Svg>,
  swap: <Svg><path d="M17 3v12" /><path d="m13 11 4 4 4-4" /><path d="M7 21V9" /><path d="m3 13 4-4 4 4" /></Svg>,
  layers: <Svg><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></Svg>,
  activity: <Svg><path d="M3 12h4l3-8 4 16 3-8h4" /></Svg>,
  wallets: <Svg><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.4" /><path d="M16 14.2c2.9.2 5 2.4 5 5.8" /></Svg>,
  status: <Svg><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></Svg>,
  search: <Svg><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Svg>,
  info: <Svg size={14}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6v.1" /></Svg>,
  refresh: <Svg size={14}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></Svg>,
  download: <Svg size={14}><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></Svg>,
  calendar: <Svg size={14}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17" /><path d="M8 3v4M16 3v4" /></Svg>,
  coin: <Svg><circle cx="12" cy="12" r="8.5" /><path d="M14.8 9.3c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.7.8-2.7 2 0 2.9 5.6 1.4 5.6 4.1 0 1.2-1.2 2-2.9 2-1.4 0-2.5-.5-3.1-1.4" /><path d="M12 6.5v1.6M12 15.9v1.6" /></Svg>,
  trend: <Svg><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></Svg>,
  volume: <Svg><path d="M5 20V11M12 20V4M19 20v-6" /></Svg>,
  pie: <Svg><path d="M21 12A9 9 0 1 1 12 3v9h9Z" /><path d="M15.5 3.5A9 9 0 0 1 20.5 8.5H15.5v-5Z" /></Svg>,
  down: <Svg><path d="M12 4v15" /><path d="m6 13 6 6 6-6" /></Svg>,
  up: <Svg><path d="M12 20V5" /><path d="m6 11 6-6 6 6" /></Svg>,
  chain: <Svg><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></Svg>,
  external: <Svg size={12}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>,
};

/** Brand mark: opposing in/out arrows on a gradient tile. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b6cff" />
          <stop offset="1" stopColor="#e155d6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#brand-g)" />
      <path d="M10 12h12m0 0-3.5-3.5M22 12l-3.5 3.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M22 20H10m0 0 3.5 3.5M10 20l3.5-3.5" stroke="#fff" strokeOpacity=".7" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
