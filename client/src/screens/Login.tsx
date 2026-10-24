import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setInterval(() => setWait((value) => Math.max(0, value - 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [wait]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      onDone();
    } catch (reason) {
      if (reason instanceof ApiError) {
        setError(reason.message);
        if (reason.retryAfterMs > 0) setWait(reason.retryAfterMs);
      } else setError('Could not sign in.');
    }
  }

  return (
    <main className="grid h-full place-items-center p-6">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm space-y-3 rounded-control border border-line bg-surface p-6">
        <h1 className="text-base font-[560]">Larder</h1>
        <label className="block text-muted">
          Username
          <input className="field mt-1" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="block text-muted">
          Password
          <input className="field mt-1" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <p key={error} className="notice text-danger">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={wait > 0}>
          {wait > 0 ? `Wait ${Math.ceil(wait / 1000)}s` : 'Enter'}
        </button>
      </form>
    </main>
  );
}
