import { api, clean, flat, labelMap, meta, type SearchParams } from '@/lib/api';
import { Card, Note, PageHeader } from '@/components/ui';
import { Field, FilterForm, Pager, Select } from '@/components/filters';
import { RangePicker, rangeParams, windowLabel } from '@/components/range';
import { SwapTable } from '@/components/swap-table';

export const dynamic = 'force-dynamic';
const LIMIT = 100;

export default async function Swaps({ searchParams }: { searchParams: SearchParams }) {
  const p = await flat(searchParams);
  const r = rangeParams(p);
  const filters = { version: p.version, side: p.side, wallet: p.wallet, min: p.min, max: p.max, sort: p.sort };
  const [m, d] = await Promise.all([meta(), api('/api/swaps', { ...r, ...filters, limit: String(LIMIT), offset: p.offset })]);

  return (
    <>
      <PageHeader title="PancakeSwap swaps" subtitle={`${windowLabel(d.window)} · DEOD swaps in the monitored V2 and V3 pools`}>
        <RangePicker path="/swaps" params={p} />
      </PageHeader>
      <Card title={`${d.total.toLocaleString('en-US')} swaps`}
        actions={<a className="link" href={`/api-export/swaps?${new URLSearchParams(clean({ ...r, ...filters }))}`}>Export CSV (up to 10,000 rows)</a>}>
        <FilterForm action="/swaps" params={p}>
          <Field label="Version"><Select name="version" value={p.version} options={[['all', 'V2 + V3'], ['2', 'V2'], ['3', 'V3']]} /></Field>
          <Field label="Side"><Select name="side" value={p.side} options={[['', 'BUY + SELL'], ['BUY', 'BUY'], ['SELL', 'SELL']]} /></Field>
          <Field label="Trader (signer)"><input name="wallet" defaultValue={p.wallet} placeholder="0x…" className="w-80 font-mono" pattern="0x[0-9a-fA-F]{40}" /></Field>
          <Field label="Min DEOD"><input name="min" type="number" min="0" step="any" defaultValue={p.min} className="w-28" /></Field>
          <Field label="Max DEOD"><input name="max" type="number" min="0" step="any" defaultValue={p.max} className="w-28" /></Field>
          <Field label="Sort"><Select name="sort" value={p.sort} options={[['time', 'Newest first'], ['amount', 'Largest first']]} /></Field>
        </FilterForm>
        <SwapTable rows={d.rows} labels={labelMap(m)} explorer={m.chain.explorer_tx_url} />
        <Pager path="/swaps" params={p} total={d.total} limit={LIMIT} />
      </Card>
      <div className="mt-3"><Note>{m.traderNote}</Note></div>
    </>
  );
}
