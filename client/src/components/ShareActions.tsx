import { useState } from 'react';
import { api } from '../api';
import { CopyIconButton } from './CopyIconButton';
import { Icon } from './Icons';
import { formatStamp } from '../format';

export type ShareLink = {
  id: string;
  root: string;
  path: string;
  name: string;
  owner: string;
  expires: number | null;
  created: string;
  hasPassword: boolean;
  zip?: boolean;
  note: string;
  opens: number;
  lastOpen: string | null;
  upload?: boolean;
};

export function ShareActions({ share, onChange, onRevoke }: { share: ShareLink; onChange: (share: ShareLink) => void; onRevoke: () => void }) {
  const url = `${window.location.origin}${share.upload ? '/u/' : '/s/'}${share.id}`;
  const [qr, setQr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(share.note);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [days, setDays] = useState('keep');
  const [error, setError] = useState('');

  async function save() {
    setError('');
    try {
      const body: { note: string; password?: string; clearPassword?: boolean; days?: number | null } = { note };
      if (clearPassword) body.clearPassword = true;
      else if (password) body.password = password;
      if (days !== 'keep') body.days = days ? Number(days) : null;
      const next = await api<ShareLink>(`/api/shares/${share.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onChange(next);
      setPassword('');
      setClearPassword(false);
      setDays('keep');
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the link.');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>{url}</span>
        <CopyIconButton value={url} />
        <button className={`icon-btn grid size-8 shrink-0 place-items-center rounded-control ${qr ? 'bg-select' : 'bg-hover'}`} type="button" aria-label="QR code" title="QR code" onClick={() => setQr((open) => !open)}>
          <Icon name="link" size={16} />
        </button>
        <button className="btn" type="button" onClick={onRevoke}>Revoke</button>
      </div>
      {qr && <img className="rounded-control bg-surface" src={`/api/shares/${share.id}/qr`} width={180} height={180} alt="QR code for this link" />}
      <p className="text-xs text-muted">
        {share.note || 'No note'}
        <span className="px-1.5">·</span>
        {share.upload ? 'Upload link' : 'Download link'}
        <span className="px-1.5">·</span>
        {share.hasPassword ? 'Password' : 'No password'}
        <span className="px-1.5">·</span>
        {share.expires ? `Expires ${formatStamp(share.expires)}` : 'No expiry'}
        <span className="px-1.5">·</span>
        {share.opens === 1 ? 'Opened once' : `Opened ${share.opens} times`}
        {share.lastOpen ? ` · Last ${formatStamp(Date.parse(share.lastOpen))}` : ''}
      </p>
      {editing ? (
        <div className="flex flex-col gap-2">
          <input className="field" value={note} placeholder="Note" maxLength={200} onChange={(event) => setNote(event.target.value)} />
          <input className="field" type="password" value={password} placeholder="New password" autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} />
            Remove password
          </label>
          <select className="field" value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="keep">Keep expiry</option>
            <option value="">No expiry</option>
            <option value="1">Expires in 1 day</option>
            <option value="7">Expires in 7 days</option>
            <option value="30">Expires in 30 days</option>
          </select>
          {error && <p key={error} className="notice text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <button className="btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn btn-primary" type="button" onClick={() => void save()}>Save</button>
          </div>
        </div>
      ) : (
        <button className="btn self-start" type="button" onClick={() => { setNote(share.note); setEditing(true); }}>Change</button>
      )}
    </div>
  );
}
