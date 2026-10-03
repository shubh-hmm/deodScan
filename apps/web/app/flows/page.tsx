import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { Addr, Card, Deod, Dir, Empty, Note, PageHeader, Tx } from '@/components/ui';
import { Field, FilterForm, Pager, Select } from '@/components/filters';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';

export const dynamic = 'force-dynamic';
const LIMIT = 100;

export default async function Flows({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const filters = { exchange: p.exchange, direction: p.direction, wallet: p.wallet, min: p.min, max: p.max, sort: p.sort };
  const [m, d] = await Promise.all([meta(), api('/api/flows', { ...r, ...filters, limit: String(LIMIT), offset: p.offset })]);
  const labels = labelMap(m);

  return (
    <>
      <PageHeader title="Exchange flows" subtitle={`${windowLabel(d.window)} · DEOD transfers into (IN) and out of (OUT) monitored exchange addresses`}>
        <RangePicker path="/flows" params={p} />
      </PageHeader>
      <Card title={`${d.total.toLocaleString('en-US')} transfers`}
        actions={<a className="link" href={`/api-export/flows?${new URLSearchParams(clean({ ...r, ...filters }))}`}>Export CSV (up to 10,000 rows)</a>}>
        <FilterForm action="/flows" params={p}>
          <Field label="Exchange"><Select name="exchange" value={p.exchange} options={[['', 'All'], ...m.exchanges.map((e) => [e.slug, e.name] as [string, string])]} /></Field>
          <Field label="Direction"><Select name="direction" value={p.direction} options={[['', 'IN + OUT'], ['IN', 'IN (to exchange)'], ['OUT', 'OUT (from exchange)']]} /></Field>
          <Field label="Wallet"><input name="wallet" defaultValue={p.wallet} placeholder="0x…" className="w-80 font-mono" pattern="0x[0-9a-fA-F]{40}" /></Field>
          <Field label="Min DEOD"><input name="min" type="number" min="0" step="any" defaultValue={p.min} className="w-28" /></Field>
          <Field label="Max DEOD"><input name="max" type="number" min="0" step="any" defaultValue={p.max} className="w-28" /></Field>
          <Field label="Sort"><Select name="sort" value={p.sort} options={[['time', 'Newest first'], ['amount', 'Largest first']]} /></Field>
        </FilterForm>
        {d.rows.length ? (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Time (UTC)</th><th>Exchange</th><th>Direction</th><th>From</th><th>To</th><th className="r">Amount (DEOD)</th><th className="r">Block</th><th>Tx</th></tr></thead>
              <tbody>
                {d.rows.map((f: any) => (
                  <tr key={`${f.tx_hash}-${f.evt_index}-${f.direction}`}>
                    <td className="num text-ink-2">{fmtTime(f.block_time, true)}</td>
                    <td>{m.exchanges.find((e) => e.slug === f.exchange)?.name}</td>
                    <td><Dir d={f.direction} /></td>
                    <td><Addr a={f.direction === 'IN' ? f.wallet_address : f.exchange_address} labels={labels} /></td>
                    <td><Addr a={f.direction === 'IN' ? f.exchange_address : f.wallet_address} labels={labels} /></td>
                    <td className="r"><Deod v={f.amount} /></td>
                    <td className="r num text-ink-2">{f.block_number}</td>
                    <td><Tx hash={f.tx_hash} explorer={m.chain.explorer_tx_url} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No transfers match these filters.</Empty>}
        <Pager path="/flows" params={p} total={d.total} limit={LIMIT} />
      </Card>
      <div className="mt-3"><Note>{m.coverageNote}</Note></div>
    </>
  );
}
