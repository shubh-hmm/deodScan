import Link from 'next/link';
import { api, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtDeod, fmtInt, fmtTime, fmtUsd, venueName } from '@/lib/format';
import { Addr, Card, Deod, Dir, Empty, Note, PageHeader, Tx } from '@/components/ui';
import { Field, FilterForm, Pager, Select } from '@/components/filters';
import { RemoveWatch, WatchForm } from '@/components/watch-controls';

export const dynamic = 'force-dynamic';
const LIMIT = 50;

const SEVERITY: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const WATCH_TEXT: Record<string, string> = { both: 'Incoming and outgoing', incoming: 'Incoming only', outgoing: 'Outgoing only' };

/** One plain sentence per rule, built from the stored thresholds so it can never disagree with what the scanner uses. */
function ruleText(r: { kind: string; params: Record<string, number> }) {
  const p = r.params;
  switch (r.kind) {
    case 'large_transfer': return `A single deposit to or withdrawal from a monitored exchange address of at least ${fmtInt(p.min_amount)} DEOD.`;
    case 'large_swap': return `A single PancakeSwap swap of at least ${fmtInt(p.min_amount)} DEOD.`;
    case 'flow_spike': return `A finished UTC day where an exchange's total IN (or OUT) is at least ${p.multiplier}× its ${p.baseline_days}-day daily average and at least ${fmtInt(p.min_amount)} DEOD. Needs ${p.min_history_days} days of history for that exchange; with less, nothing is flagged.`;
    default: return 'Any recorded exchange transfer or swap involving a wallet on your watchlist.';
  }
}

export default async function Alerts({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const m = await meta();
  const labels = labelMap(m);

  let data: any, rules: any, watch: any;
  try {
    [data, rules, watch] = await Promise.all([
      api('/api/alerts', { rule: p.rule, exchange: p.exchange, wallet: p.wallet, limit: String(LIMIT), offset: p.offset }),
      api('/api/alert-rules'),
      api('/api/watchlist'),
    ]);
  } catch {
    return (
      <>
        <PageHeader title="Alerts" subtitle="Automatic, rule-based alerts on recorded DEOD transfers and swaps." />
        <Card><Empty>Alerts are not available yet. Restart the backend (<span className="font-mono">npm run dev</span> in the backend folder) so it can apply the database update, then reload.</Empty></Card>
      </>
    );
  }

  const filters = { rule: p.rule, exchange: p.exchange, wallet: p.wallet };
  return (
    <>
      <PageHeader title="Alerts" eyebrow="Monitoring" subtitle="Automatic, rule-based alerts on recorded DEOD transfers and swaps. Detection uses fixed rules, not AI." />
      <Note>{data.limitation}</Note>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {rules.rules.map((r: any) => (
          <div key={r.code} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{r.name}</h3>
              <span className="pill">{r.enabled ? SEVERITY[r.severity] : 'Off'}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-2">{ruleText(r)}</p>
            <p className="mt-3 text-xs text-muted">{fmtInt(r.alerts)} alerts{r.latest_alert ? ` · latest ${fmtTime(r.latest_alert)} UTC` : ''}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        {rules.lastScan ? `Last scan: ${fmtTime(rules.lastScan, true)} UTC. ` : 'No scan has run yet. '}
        Alerts are created after each sync (or Update today). To scan the stored data now, with no Dune credits, run{' '}
        <span className="font-mono">npx tsx worker/src/cli.ts alerts</span> in the backend folder. Thresholds are in <span className="font-mono">backend/config/alerts.yaml</span>.
      </p>

      <div className="mt-6"><Card title={`Watched wallets (${watch.rows.length} of ${watch.max})`}>
        <WatchForm />
        {watch.rows.length ? (
          <div className="overflow-x-auto"><table className="data">
            <thead><tr><th>Wallet</th><th>Label</th><th>Alert on</th><th className="r">Min. DEOD</th><th className="r">Alerts</th><th /></tr></thead>
            <tbody>{watch.rows.map((w: any) => (
              <tr key={w.address}>
                <td><Addr a={w.address} labels={labels} /></td>
                <td className="text-ink-2">{w.label ?? '—'}</td>
                <td>{WATCH_TEXT[w.watch]}</td>
                <td className="r"><Deod v={w.min_amount} /></td>
                <td className="r num"><Link className="link" href={`/alerts?wallet=${w.address}`}>{fmtInt(w.alerts)}</Link></td>
                <td className="r"><RemoveWatch address={w.address} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No wallets are being watched. Add one above, or press “Watch this wallet” on a wallet page.</Empty>}
      </Card></div>

      <div className="mt-6"><Card title={`Alerts (${fmtInt(data.total)})`}>
        <FilterForm action="/alerts" params={filters}>
          <Field label="Rule"><Select name="rule" value={p.rule} options={[['', 'All rules'], ...rules.rules.map((r: any): [string, string] => [r.code, r.name])]} /></Field>
          <Field label="Exchange"><Select name="exchange" value={p.exchange} options={[['', 'All exchanges'], ...m.exchanges.map((e): [string, string] => [e.slug, e.name])]} /></Field>
          <Field label="Wallet address"><input name="wallet" defaultValue={p.wallet ?? ''} placeholder="0x…" className="w-[22rem] font-mono" /></Field>
        </FilterForm>
        {data.rows.length ? (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Time (UTC)</th><th>Rule</th><th>Venue</th><th>Direction</th><th className="r">Amount</th><th>Sender</th><th>Recipient</th><th>Transaction</th></tr></thead>
              <tbody>
                {data.rows.map((a: any) => (
                  <tr key={a.id}>
                    <td className="num text-ink-2">{fmtTime(a.occurred_at, true)}</td>
                    <td><span className="block text-sm">{a.rule_name}</span><span className="text-xs text-muted">{SEVERITY[a.severity]}</span></td>
                    <td>{a.exchange ? venueName(a.exchange) : a.source === 'swap' ? 'PancakeSwap' : '—'}</td>
                    <td>{a.direction ? <Dir d={a.direction} /> : '—'}</td>
                    <td className="r"><Deod v={a.amount} />{a.usd_value ? <span className="block text-xs text-muted">{fmtUsd(a.usd_value)}</span> : null}</td>
                    <td>{a.sender ? <Addr a={a.sender} labels={labels} /> : '—'}</td>
                    <td>{a.recipient ? <Addr a={a.recipient} labels={labels} /> : '—'}</td>
                    <td>
                      {a.tx_hash ? <Tx hash={a.tx_hash} explorer={m.chain.explorer_tx_url} /> : (
                        <span className="text-xs text-ink-2" title="Daily total, not a single transaction">
                          {a.details?.ratio ? `${a.details.ratio}× the ${a.details.tracked_days}-day average` : `quiet for ${a.details?.tracked_days} days before`}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No alerts yet{p.rule || p.exchange || p.wallet ? ' for these filters' : ''}. They appear after a sync finds a transfer or swap that matches a rule.</Empty>}
        <Pager path="/alerts" params={{ ...filters, offset: p.offset }} total={data.total} limit={LIMIT} />
      </Card></div>
    </>
  );
}
