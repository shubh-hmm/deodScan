import { fmtPrice, fmtTime, fmtUsd } from '@/lib/format';
import { Addr, Deod, Dir, Empty, Tx } from '@/components/ui';

export function SwapTable({ rows, labels, explorer }: { rows: any[]; labels: Map<string, string>; explorer: string }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead><tr><th>Time (UTC)</th><th>Pool</th><th>Side</th><th>Trader (signer)</th><th>Recipient</th><th className="r">DEOD</th><th className="r">USDT</th><th className="r">Price</th><th className="r">Block</th><th>Tx</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={`${x.tx_hash}-${x.evt_index}`}>
              <td className="num text-ink-2">{fmtTime(x.block_time, true)}</td>
              <td>V{x.version}</td>
              <td><Dir d={x.side} /></td>
              <td><Addr a={x.trader_address} labels={labels} /></td>
              <td>{x.recipient_address === x.trader_address ? <span className="text-xs text-muted">same</span> : <Addr a={x.recipient_address} labels={labels} link={false} />}</td>
              <td className="r"><Deod v={x.deod_amount} /></td>
              <td className="r num">{fmtUsd(x.quote_amount).replace('$', '')}</td>
              <td className="r num">{fmtPrice(x.price)}</td>
              <td className="r num text-ink-2">{x.block_number}</td>
              <td><Tx hash={x.tx_hash} explorer={explorer} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
