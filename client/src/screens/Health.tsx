import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes } from '../format';

type Health = {
  roots: { id: string; name: string; path: string; ok: boolean; freeBytes: number | null; totalBytes: number | null; low?: boolean }[];
  shares: number;
  uploads: { count: number; bytes: number };
  activityBytes: number;
  clam: 'installed' | 'missing';
  host: {
    memory: { usedBytes: number; totalBytes: number };
    cpu: number | null;
    network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  };
};

export function Health() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    const load = () => {
      void api<Health>('/api/health')
        .then((data) => {
          if (!stopped) {
            setHealth(data);
            setError('');
          }
        })
        .catch((reason: unknown) => {
          if (!stopped) setError(reason instanceof Error ? reason.message : 'Could not load health');
        });
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
  const memoryPercent = health && health.host.memory.totalBytes > 0 ? (health.host.memory.usedBytes / health.host.memory.totalBytes) * 100 : null;
  const down = health?.host.network.rxBytesPerSec;
  const up = health?.host.network.txBytesPerSec;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div>
          <h2 className="text-lg">Health</h2>
          <p className="text-sm text-muted">Memory, processor, network, disk space, shares, and uploads still in progress.</p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {health && (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Meter label="Memory" value={`${formatBytes(health.host.memory.usedBytes)} of ${formatBytes(health.host.memory.totalBytes)}`} percent={memoryPercent} />
              <Meter label="Processor" value={health.host.cpu == null ? 'Measuring…' : `${health.host.cpu}%`} percent={health.host.cpu} />
              <Card label="Network" value={down == null || up == null ? 'Measuring…' : `${formatBytes(down)}/s down · ${formatBytes(up)}/s up`} />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Card label="Share links" value={String(health.shares)} />
              <Card label="Uploads in progress" value={health.uploads.count === 0 ? 'None' : `${health.uploads.count} · ${formatBytes(health.uploads.bytes)}`} />
              <Card label="Activity log" value={formatBytes(health.activityBytes)} />
            </div>
            <p className="text-sm text-muted">Virus scan: {health.clam === 'installed' ? 'ClamAV is installed. New uploads are scanned.' : 'ClamAV is not installed. Uploads are not scanned.'}</p>
            {health.roots.some((root) => root.low) && <p className="text-sm text-danger">A disk is nearly full. Free space is under 10%, or under 5 GB.</p>}
            <div className="flex flex-col gap-2">
              {health.roots.map((root) => (
                <div key={root.id} className={`rounded-control border bg-surface px-4 py-3 ${root.low ? 'border-danger' : 'border-split'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span>{root.name}</span>
                    <span className={`text-sm ${root.low ? 'text-danger' : 'text-muted'}`}>{root.ok && root.freeBytes != null ? `${formatBytes(root.freeBytes)} free${root.totalBytes != null ? ` of ${formatBytes(root.totalBytes)}` : ''}${root.low ? ' · Nearly full' : ''}` : 'Not available'}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted">{root.path}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-split bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1">{value}</p>
    </div>
  );
}

function Meter({ label, value, percent }: { label: string; value: string; percent: number | null }) {
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="rounded-control border border-split bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1">{value}</p>
      <div className="mt-2 h-1 overflow-hidden rounded-control bg-page">
        <div className="h-full bg-accent" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
