'use client';

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useId } from 'react';
import { SERIES } from '@/lib/colors';
import { compactNum } from '@/lib/format';

// Text never wears a series colour; marks beside the text carry identity.
const SURFACE = '#121a2c';
const GRID = '#1f2a44';
const AXIS = '#2c3858';
const MUTED = '#8a93b5';
const INK2 = '#c4cae0';

const full = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export interface PairPoint { bucket: string; a: number; b: number }
export interface CumPoint extends PairPoint { cum: number }

function tickTime(bucket: 'hour' | 'day') {
  return (v: string) => {
    const iso = new Date(v).toISOString();
    return bucket === 'hour' ? iso.slice(11, 16) : iso.slice(5, 10);
  };
}

const stamp = (label: string, bucket: 'hour' | 'day') => {
  const iso = new Date(label).toISOString();
  return bucket === 'hour' ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : `${iso.slice(0, 10)} UTC`;
};

/** Tooltip row: a short line-key in the series colour, the name in secondary ink, the value strong. */
function Row({ color, name, value }: { color: string; name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="flex items-center gap-2 text-ink-2">
        <span className="inline-block h-[3px] w-3 rounded-full" style={{ background: color }} />{name}
      </span>
      <span className="num font-semibold text-ink">{value}</span>
    </div>
  );
}

const tipClass = 'rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs shadow-xl';

function PairTooltip({ active, payload, label, bucket, names, unit }: any) {
  if (!active || !payload?.length) return null;
  const a = payload.find((p: any) => p.dataKey === 'a')?.value ?? 0;
  const b = payload.find((p: any) => p.dataKey === 'b')?.value ?? 0;
  return (
    <div className={tipClass}>
      <div className="mb-1.5 text-muted">{stamp(label, bucket)}</div>
      <Row color={SERIES.in} name={names[0]} value={`${full.format(a)} ${unit}`} />
      <Row color={SERIES.out} name={names[1]} value={`${full.format(b)} ${unit}`} />
      {names[2] && (
        <div className="mt-1.5 flex justify-between gap-6 border-t border-line pt-1.5">
          <span className="text-ink-2">{names[2]}</span>
          <span className="num font-semibold text-ink">{a - b > 0 ? '+' : ''}{full.format(a - b)} {unit}</span>
        </div>
      )}
    </div>
  );
}

const axisTick = { fill: MUTED, fontSize: 11 };

/**
 * Two-series grouped bars over time (IN vs OUT, BUY vs SELL). Empty buckets are zeros, so a quiet hour reads as
 * zero rather than a missing bar. Bars are capped at 24px with a 4px rounded top and a 2px gap between the pair.
 */
export function PairBars({
  data, bucket, names, unit = 'DEOD', height = 260,
}: { data: PairPoint[]; bucket: 'hour' | 'day'; names: [string, string, string?]; unit?: string; height?: number }) {
  if (!data.length) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No activity in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barGap={2} barCategoryGap="22%" margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="bucket" tickFormatter={tickTime(bucket)} stroke={AXIS} tick={axisTick} tickLine={false} minTickGap={28} />
        <YAxis tickFormatter={compactNum} stroke={AXIS} tick={axisTick} tickLine={false} axisLine={false} width={46} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<PairTooltip bucket={bucket} names={names} unit={unit} />} />
        <Legend verticalAlign="top" align="right" height={26} iconType="rect" iconSize={10}
          formatter={(v) => <span style={{ color: INK2, fontSize: 12, marginRight: 6 }}>{v}</span>} />
        <Bar dataKey="a" name={names[0]} fill={SERIES.in} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        <Bar dataKey="b" name={names[1]} fill={SERIES.out} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Small decorative trend for a stat tile. The tile's number carries the value; this only shows the shape. */
export function Sparkline({ data, color, height = 36 }: { data: number[]; color: string; height?: number }) {
  if (data.length < 2) return null;
  const pts = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={pts} margin={{ top: 4, right: 4, bottom: 2, left: 4 }}>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={color} fillOpacity={0.1}
          dot={false} activeDot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function CumTooltip({ active, payload, bucket, unit }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as CumPoint;
  return (
    <div className={tipClass}>
      <div className="mb-1.5 text-muted">{stamp(p.bucket, bucket)}</div>
      <Row color={SERIES.net} name="Cumulative net" value={`${p.cum > 0 ? '+' : ''}${full.format(p.cum)} ${unit}`} />
      <div className="mt-1.5 border-t border-line pt-1.5">
        <Row color={SERIES.in} name="IN this period" value={`${full.format(p.a)} ${unit}`} />
        <Row color={SERIES.out} name="OUT this period" value={`${full.format(p.b)} ${unit}`} />
      </div>
    </div>
  );
}

/** Vertical colour fade for an area fill: strong at the line, transparent at the baseline. */
function Fade({ id, color, top = 0.4 }: { id: string; color: string; top?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={top} />
      <stop offset="100%" stopColor={color} stopOpacity={0.02} />
    </linearGradient>
  );
}

/** White dot with a series-coloured ring, shown on each point only while the series is short enough to stay readable. */
const dotFor = (color: string, count: number) => (count <= 45 ? { r: 3.5, fill: '#ffffff', stroke: color, strokeWidth: 2 } : false);
const activeDot = (color: string) => ({ r: 5.5, fill: '#ffffff', stroke: color, strokeWidth: 2.5 });

/** One series (cumulative net flow since the window start): 2px line, gradient wash, crosshair and a zero baseline. */
export function CumulativeArea({
  data, bucket, unit = 'DEOD', height = 250,
}: { data: CumPoint[]; bucket: 'hour' | 'day'; unit?: string; height?: number }) {
  const gid = useId().replace(/:/g, '');
  if (data.length < 2) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>Not enough activity in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 10, right: 14, bottom: 0, left: 4 }}>
        <defs><Fade id={`cum-${gid}`} color={SERIES.net} top={0.38} /></defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="bucket" tickFormatter={tickTime(bucket)} stroke={AXIS} tick={axisTick} tickLine={false} minTickGap={28} />
        <YAxis tickFormatter={compactNum} stroke={AXIS} tick={axisTick} tickLine={false} axisLine={false} width={46} />
        <ReferenceLine y={0} stroke={AXIS} />
        <Tooltip cursor={{ stroke: MUTED, strokeWidth: 1 }} content={<CumTooltip bucket={bucket} unit={unit} />} />
        <Area type="linear" dataKey="cum" stroke={SERIES.net} strokeWidth={2} fill={`url(#cum-${gid})`}
          dot={dotFor(SERIES.net, data.length)} activeDot={activeDot(SERIES.net)} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Two overlapping areas over time (IN vs OUT, BUY vs SELL): blue gradient area plus an orange line, each with white
 * dot markers, and a crosshair tooltip listing both values. The series names and totals are shown in chips above.
 */
export function FlowArea({
  data, bucket, names, unit = 'DEOD', height = 340,
}: { data: PairPoint[]; bucket: 'hour' | 'day'; names: [string, string, string?]; unit?: string; height?: number }) {
  const gid = useId().replace(/:/g, '');
  if (!data.length) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No activity in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 10, right: 14, bottom: 0, left: 4 }}>
        <defs>
          <Fade id={`in-${gid}`} color={SERIES.in} top={0.45} />
          <Fade id={`out-${gid}`} color={SERIES.out} top={0.22} />
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="bucket" tickFormatter={tickTime(bucket)} stroke={AXIS} tick={axisTick} tickLine={false} minTickGap={28} />
        <YAxis tickFormatter={compactNum} stroke={AXIS} tick={axisTick} tickLine={false} axisLine={false} width={46} />
        <Tooltip cursor={{ stroke: MUTED, strokeWidth: 1 }} content={<PairTooltip bucket={bucket} names={names} unit={unit} />} />
        <Area type="monotone" dataKey="a" name={names[0]} stroke={SERIES.in} strokeWidth={2} fill={`url(#in-${gid})`}
          dot={dotFor(SERIES.in, data.length)} activeDot={activeDot(SERIES.in)} isAnimationActive={false} />
        <Area type="monotone" dataKey="b" name={names[1]} stroke={SERIES.out} strokeWidth={2} fill={`url(#out-${gid})`}
          dot={dotFor(SERIES.out, data.length)} activeDot={activeDot(SERIES.out)} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface Slice { name: string; value: number; color: string }

function SliceTooltip({ active, payload, unit }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className={tipClass}>
      <Row color={d.payload.color} name={d.name} value={`${full.format(d.value)} ${unit}`} />
      <div className="mt-1 text-muted">{(d.payload.pct as number).toFixed(1)}% of total</div>
    </div>
  );
}

/**
 * Donut for a part-to-whole at a glance (3 slices here). Slices are separated by a 2px surface gap; the centre shows
 * the total, and the page lists every slice with its value and share next to it, so nothing depends on colour.
 */
export function Donut({ slices, centerLabel, centerValue, unit = 'DEOD', height = 180 }: {
  slices: Slice[]; centerLabel: string; centerValue: string; unit?: string; height?: number;
}) {
  const total = slices.reduce((a, x) => a + x.value, 0);
  if (!(total > 0)) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No activity in this period.</div>;
  const data = slices.filter((x) => x.value > 0).map((x) => ({ ...x, pct: (x.value / total) * 100 }));
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<SliceTooltip unit={unit} />} />
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="94%" startAngle={90} endAngle={-270}
            stroke={SURFACE} strokeWidth={2} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[11px] text-muted">{centerLabel}</div>
        <div className="num text-xl font-semibold text-ink">{centerValue}</div>
      </div>
    </div>
  );
}

export interface HourPoint { hour: number; inflows: number; outflows: number }

function HourTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as HourPoint;
  const hh = String(p.hour).padStart(2, '0');
  return (
    <div className={tipClass}>
      <div className="mb-1.5 text-muted">{hh}:00–{hh}:59 UTC</div>
      <Row color={SERIES.in} name="IN transfers" value={full.format(p.inflows)} />
      <Row color={SERIES.out} name="OUT transfers" value={full.format(p.outflows)} />
    </div>
  );
}

/** Stacked IN / OUT transfer counts by UTC hour of day: when exchange activity happens. 2px surface gap between segments. */
export function HourBars({ data, height = 230 }: { data: HourPoint[]; height?: number }) {
  if (!data.some((d) => d.inflows + d.outflows > 0)) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No activity in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barCategoryGap="18%" margin={{ top: 8, right: 10, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="hour" tickFormatter={(h) => String(h).padStart(2, '0')} stroke={AXIS} tick={axisTick} tickLine={false} interval={1} />
        <YAxis tickFormatter={compactNum} stroke={AXIS} tick={axisTick} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<HourTooltip />} />
        <Bar dataKey="inflows" stackId="h" fill={SERIES.in} stroke={SURFACE} strokeWidth={2} maxBarSize={20} isAnimationActive={false} />
        <Bar dataKey="outflows" stackId="h" fill={SERIES.out} stroke={SURFACE} strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
