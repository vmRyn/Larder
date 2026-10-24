import { useEffect, useState } from 'react';
import { api, type RootInfo } from '../api';
import { Icon } from '../components/Icons';
import { ShareActions, type ShareLink } from '../components/ShareActions';
import { formatStamp, parentPath } from '../format';

export function Shared({
  roots,
  admin,
  onOpen,
}: {
  roots: RootInfo[];
  admin: boolean;
  onOpen: (root: string, path: string) => void;
}) {
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const data = await api<{ shares: ShareLink[] }>('/api/shares');
    setShares(Array.isArray(data.shares) ? data.shares : []);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load shares'));
  }, []);

  async function revoke(share: ShareLink) {
    setError('');
    try {
      await api(`/api/shares/${share.id}`, { method: 'DELETE' });
      setShares((current) => current.filter((item) => item.id !== share.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not revoke that link.');
    }
  }

  const query = filter.trim().toLowerCase();
  const shown = shares.filter((share) => {
    if (!query) return true;
    const rootName = roots.find((item) => item.id === share.root)?.name ?? share.root;
    return [share.name, share.path, share.owner, share.note, rootName].some((value) => value.toLowerCase().includes(query));
  });

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div>
          <h2 className="text-lg">Shared</h2>
          <p className="text-sm text-muted">{shares.length === 1 ? '1 link' : `${shares.length} links`}</p>
        </div>
        <input className="field max-w-xs" value={filter} placeholder="Filter links" onChange={(event) => setFilter(event.target.value)} />
        {error && <p key={error} className="notice text-sm text-danger">{error}</p>}
        <ul className="flex flex-col gap-2">
          {shown.map((share) => {
            const rootName = roots.find((item) => item.id === share.root)?.name ?? share.root;
            const expired = share.expires != null && share.expires <= Date.now();
            const canOpen = roots.some((item) => item.id === share.root);
            return (
              <li key={share.id} className="rounded-control border border-split bg-surface px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-control bg-page">
                    <Icon name={share.zip ? 'archive' : 'link'} size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate">{share.name}</span>
                      {share.zip && <Chip>Folder zip</Chip>}
                      {share.hasPassword && <Chip>Password</Chip>}
                      {expired && <Chip tone="danger">Expired</Chip>}
                    </div>
                    <p className="truncate text-sm text-muted">{share.path ? `${rootName} / ${share.path}` : rootName}</p>
                    <p className="mt-1 text-xs text-muted">
                      {share.expires ? `Expires ${formatStamp(share.expires)}` : 'No expiry'}
                      <span className="px-1.5">·</span>
                      {`Created ${formatStamp(Date.parse(share.created))}`}
                      {admin && (
                        <>
                          <span className="px-1.5">·</span>
                          {share.owner}
                        </>
                      )}
                    </p>
                    <div className="mt-3">
                      <ShareActions
                        share={share}
                        onChange={(next) => setShares((current) => current.map((item) => (item.id === next.id ? next : item)))}
                        onRevoke={() => void revoke(share)}
                      />
                    </div>
                  </div>
                  {canOpen && (
                    <button className="btn shrink-0" type="button" onClick={() => onOpen(share.root, share.zip ? share.path : parentPath(share.path))}>
                      Show
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && !error && <p className="text-sm text-muted">{shares.length === 0 ? 'Nothing is shared.' : 'No links match that filter.'}</p>}
      </div>
    </div>
  );
}

function Chip({ children, tone }: { children: string; tone?: 'danger' }) {
  return <span className={`rounded-control bg-page px-1.5 py-0.5 text-xs ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{children}</span>;
}
