import { api, meta } from '@/lib/api';
import { fmtAgo, fmtInt, fmtTime } from '@/lib/format';
import { Card, Empty, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

function StatusBadge({ s }: { s: string }) {
  const tone = s === 'ok' ? 'text-good' : s === 'error' ? 'text-critical' : s === 'running' ? 'text-warning' : 'text-muted';
  const icon = s === 'ok' ? '●' : s === 'error' ? '▲' : s === 'running' ? '◐' : '○';
  return <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`}><span aria-hidden>{icon}</span>{s.toUpperCase()}</span>;
}

export default async function Status() {
  const [m, s] = await Promise.all([meta(), api('/api/sync/status')]);
  return (
    <>
      <PageHeader eyebrow="System" title="Sync status" subtitle="Dune → PostgreSQL synchronisation. Each completed UTC day is fetched once; the worker checks hourly and makes no Dune call when nothing new has finished." />

      <Card title="Queries">
        <table className="data">
          <thead><tr><th>Query</th><th>Status</th><th>Newest block time ingested</th><th>Synced until</th><th>Last sync</th><th className="r">Dune credits (total)</th><th>Error</th></tr></thead>
          <tbody>
            {s.queries.map((q: any) => (
              <tr key={q.query_name}>
                <td className="font-mono text-xs">{q.query_name}</td>
                <td><StatusBadge s={q.status} /></td>
                <td className="num">{fmtTime(q.last_block_time, true)} <span className="text-xs text-muted">({fmtAgo(q.last_block_time)})</span></td>
                <td className="num">{fmtTime(q.synced_until)}</td>
                <td className="num">{fmtAgo(q.last_sync_at)}</td>
                <td className="r num">{Number(q.credits_total).toFixed(2)}</td>
                <td className="max-w-xs truncate text-xs text-critical" title={q.error ?? ''}>{q.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 py-2.5 text-xs text-ink-2">
          Rejected rows (validation failures, kept for review): <span className="num">{fmtInt(s.rejectedRows)}</span>
        </div>
      </Card>

      <Card title="Recent Dune executions" className="mt-4">
        {s.recentRuns.length ? (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>#</th><th>Query</th><th>Mode</th><th>Window (UTC)</th><th>Status</th><th className="r">Fetched</th><th className="r">Inserted</th><th className="r">Duplicates</th><th className="r">Rejected</th><th className="r">Credits</th><th>Started</th></tr></thead>
              <tbody>
                {s.recentRuns.map((r: any) => (
                  <tr key={r.id}>
                    <td className="text-muted">{r.id}</td>
                    <td className="font-mono text-xs">{r.query_name}</td>
                    <td>{r.mode}</td>
                    <td className="num text-xs">{fmtTime(r.window_start)} → {fmtTime(r.window_end)}</td>
                    <td title={r.error ?? ''}><StatusBadge s={r.status} /></td>
                    <td className="r num">{fmtInt(r.rows_fetched)}</td>
                    <td className="r num">{fmtInt(r.rows_inserted)}</td>
                    <td className="r num">{fmtInt(r.rows_duplicate)}</td>
                    <td className="r num">{fmtInt(r.rows_rejected)}</td>
                    <td className="r num">{r.credits ? Number(r.credits).toFixed(2) : '—'}</td>
                    <td className="num text-ink-2">{fmtAgo(r.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No runs yet.</Empty>}
      </Card>

      <Card title="Monitored addresses (BNB Chain)" className="mt-4">
        <table className="data">
          <thead><tr><th>Name</th><th>Address</th><th>Type</th><th>Dune label</th><th>Source</th><th>Admin-verified</th><th>Notes</th></tr></thead>
          <tbody>
            {m.exchangeAddresses.map((a) => (
              <tr key={a.address}>
                <td>{a.name}</td><td className="font-mono text-xs">{a.address}</td><td>{a.address_type}</td>
                <td>{a.dune_label ?? '—'}</td><td>{a.source}</td><td>{a.verified ? 'Yes' : 'No'}</td>
                <td className="max-w-sm truncate text-xs text-ink-2" title={a.notes ?? ''}>{a.notes ?? ''}</td>
              </tr>
            ))}
            {m.pools.map((p) => (
              <tr key={p.address}>
                <td>PancakeSwap V{p.version}</td><td className="font-mono text-xs">{p.address}</td><td>pool · {p.pair}</td>
                <td>—</td><td>config</td><td>—</td><td className="max-w-sm truncate text-xs text-ink-2" title={p.verification ?? ''}>{p.verification}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
