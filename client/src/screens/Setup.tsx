import { useState } from 'react';
import { ApiError, api } from '../api';

export function Setup({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('Those passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
      onDone();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid h-full place-items-center p-6">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm space-y-3 rounded-control border border-line bg-surface p-6">
        <h1 className="text-base font-[560]">Larder</h1>
        <p className="text-muted">Create the admin account for this server.</p>
        <label className="block text-muted">
          Username
          <input className="field mt-1" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="block text-muted">
          Password
          <input className="field mt-1" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label className="block text-muted">
          Confirm
          <input className="field mt-1" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </label>
        {error && <p className="text-danger">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Save and continue
        </button>
      </form>
    </main>
  );
}
