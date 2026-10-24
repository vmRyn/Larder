import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { ApiError, api } from '../api';
import { CopyIconButton } from '../components/CopyIconButton';

function theme() {
  const light = document.documentElement.dataset.theme === 'light';
  return light
    ? {
        background: '#f3f3f3',
        foreground: '#1a1a1a',
        cursor: '#005fb8',
        cursorAccent: '#f3f3f3',
        selectionBackground: '#cde6f7',
      }
    : {
        background: '#191919',
        foreground: '#ffffff',
        cursor: '#60cdff',
        cursorAccent: '#191919',
        selectionBackground: '#333333',
      };
}

function TerminalHost({ ticket, rootId, path }: { ticket: string; rootId: string; path: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ ticket });
    if (rootId) {
      params.set('root', rootId);
      params.set('path', path);
    }
    const socket = new WebSocket(`${protocol}//${location.host}/api/terminal?${params}`);
    const sendResize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      if (data) term.write(data);
    });
    socket.addEventListener('open', () => {
      sendResize();
      term.focus();
    });
    socket.addEventListener('close', () => {
      term.write('\r\n\x1b[90mThe terminal closed.\x1b[0m\r\n');
    });
    const observer = new MutationObserver(() => {
      term.options.theme = theme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const frame = requestAnimationFrame(sendResize);
    window.addEventListener('resize', sendResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', sendResize);
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [ticket, rootId, path]);

  return <div ref={host} className="terminal-host" />;
}

export function TerminalPane({ rootId, path }: { rootId: string; path: string }) {
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState('');
  const [realPath, setRealPath] = useState('');
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setInterval(() => setWait((value) => Math.max(0, value - 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [wait]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const opened = await api<{ ticket: string }>('/api/terminal/unlock', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (rootId) {
        const located = await api<{ path: string }>(`/api/realpath?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`).catch(() => null);
        if (located) setRealPath(located.path);
      }
      setTicket(opened.ticket);
    } catch (reason) {
      if (reason instanceof ApiError) {
        setError(reason.message);
        if (reason.retryAfterMs > 0) setWait(reason.retryAfterMs);
      } else setError('Could not open the terminal.');
    }
  }

  if (!ticket) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <form onSubmit={(event) => void unlock(event)} className="w-full max-w-sm space-y-3 rounded-control border border-line bg-surface p-6">
          <h1 className="text-base font-[560]">Terminal</h1>
          <p className="text-sm text-muted">Enter your password again. A signed-in browser is not enough to open a shell.</p>
          <label className="block text-muted">
            Password
            <input className="field mt-1" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={wait > 0}>
            {wait > 0 ? `Wait ${Math.ceil(wait / 1000)}s` : 'Open terminal'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {realPath && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={realPath}>{realPath}</span>
          <CopyIconButton value={realPath} label="Copy folder path" />
        </div>
      )}
      <TerminalHost ticket={ticket} rootId={rootId} path={path} />
    </div>
  );
}
