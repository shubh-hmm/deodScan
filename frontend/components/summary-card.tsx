import { Card } from '@/components/ui';
import { CopyText } from '@/components/copy-text';

export interface SummaryData {
  period: string;
  headline: string;
  sections: { title: string; lines: string[] }[];
  notes: string[];
  text: string;
}

/**
 * Plain-language summary of the page for the selected period. The sentences are written by fixed rules from the same numbers the cards and
 * tables below show (nothing is estimated or generated), and the notes say what the data cannot show.
 */
export function SummaryCard({ s }: { s: SummaryData }) {
  return (
    <Card title="Summary" actions={<CopyText text={s.text} />}>
      <div className="space-y-4 p-4 text-sm leading-relaxed">
        <p className="text-[15px] text-ink">{s.headline}</p>
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          {s.sections.map((x) => (
            <div key={x.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{x.title}</h3>
              <ul className="space-y-1 text-ink-2">
                {x.lines.map((l) => <li key={l} className="break-words">{l}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <ul className="space-y-1 border-t border-line pt-3 text-xs text-muted">
          {s.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </Card>
  );
}
