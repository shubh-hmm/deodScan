'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// Validated dark-mode categorical slots (blue / orange). Text never wears series colour.
const S1 = '#3987e5';
const S2 = '#d95926';
const GRID = '#2c2c2a';
const AXIS = '#383835';
const MUTED = '#898781';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export interface PairPoint { bucket: string; a: number; b: number }

function tickTime(bucket: 'hour' | 'day') {
  return (v: string) => {
    const iso = new Date(v).toISOString();
    return bucket === 'hour' ? iso.slice(11, 16) : iso.slice(5, 10);
  };
}

function TooltipBox({ active, payload, label, bucket, names, unit }: any) {
  if (!active || !payload?.length) return null;
  const iso = new Date(label).toISOString();
  const a = payload.find((p: any) => p.dataKey === 'a')?.value ?? 0;
  const b = payload.find((p: any) => p.dataKey === 'b')?.value ?? 0;
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">{bucket === 'hour' ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : `${iso.slice(0, 10)} UTC`}</div>
      <Row color={S1} name={names[0]} value={`${full.format(a)} ${unit}`} />
      <Row color={S2} name={names[1]} value={`${full.format(b)} ${unit}`} />
      {names[2] && <div className="mt-1 border-t border-line pt-1 text-ink"><span className="text-muted">{names[2]}: </span>{a - b > 0 ? '+' : ''}{full.format(a - b)} {unit}</div>}
    </div>
  );
}

function Row({ color, name, value }: { color: string; name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 text-ink">
      <span className="flex items-center gap-1.5 text-ink-2"><span className="h-2 w-2 rounded-sm" style={{ background: color }} />{name}</span>
      <span className="num">{value}</span>
    </div>
  );
}

/**
 * Two-series grouped bars over time (IN vs OUT, BUY vs SELL). Gaps between buckets are filled with zeros
 * so an hour with no activity reads as zero, not as a missing bar.
 */
export function PairBars({
  data, bucket, names, unit = 'DEOD', height = 260,
}: { data: PairPoint[]; bucket: 'hour' | 'day'; names: [string, string, string?]; unit?: string; height?: number }) {
  if (!data.length) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No activity in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barGap={2} barCategoryGap="20%" margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="bucket" tickFormatter={tickTime(bucket)} stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} minTickGap={24} />
        <YAxis tickFormatter={(v) => compact.format(v)} stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<TooltipBox bucket={bucket} names={names} unit={unit} />} />
        <Legend verticalAlign="top" align="right" height={24} iconType="square" iconSize={8}
          formatter={(v) => <span style={{ color: '#c3c2b7', fontSize: 12 }}>{v}</span>} />
        <Bar dataKey="a" name={names[0]} fill={S1} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        <Bar dataKey="b" name={names[1]} fill={S2} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
