import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { readSession } from './auth.js';
import { logActivity } from './activity.js';

const COOKIE = 'larder_session';

function sessionId(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const split = trimmed.indexOf('=');
    if (split === -1) continue;
    if (trimmed.slice(0, split) === COOKIE) return decodeURIComponent(trimmed.slice(split + 1));
  }
  return undefined;
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function openShell(ws: WebSocket, username: string) {
  const windows = process.platform === 'win32';
  let pty: IPty;
  try {
    pty = spawn(windows ? 'powershell.exe' : 'bash', windows ? ['-NoLogo'] : ['-il'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: shellEnv(),
    });
  } catch (error) {
    ws.send(`\r\nCould not open a shell. ${error instanceof Error ? error.message : ''}\r\n`);
    ws.close();
    return;
  }
  void logActivity({ user: username, action: 'terminal', root: '', path: '' });
  pty.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  ws.on('message', (raw) => {
    let text = '';
    if (typeof raw === 'string') text = raw;
    else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
    else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
    try {
      const message = JSON.parse(text) as { type?: string; data?: string; cols?: number; rows?: number };
      if (message.type === 'input' && typeof message.data === 'string') pty.write(message.data);
      else if (message.type === 'resize' && message.cols && message.rows) {
        pty.resize(Math.max(2, message.cols), Math.max(1, message.rows));
      }
    } catch {
      pty.write(text);
    }
  });
  const stop = () => {
    try {
      pty.kill();
    } catch {
      /* The shell has already exited. */
    }
  };
  ws.on('close', stop);
  ws.on('error', stop);
  pty.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
}

type UpgradeServer = {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
};

export function attachTerminal(server: UpgradeServer) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    void acceptTerminal(sockets, request, socket, head);
  });
}

async function acceptTerminal(sockets: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer) {
  const path = (request.url ?? '/').split('?')[0];
  if (path !== '/api/terminal') {
    socket.destroy();
    return;
  }
  const user = await readSession(sessionId(request.headers.cookie));
  if (!user?.admin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => openShell(ws, user.username));
}
