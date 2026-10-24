import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { requireRoot } from './access.js';
import { logActivity } from './activity.js';
import { readSession } from './auth.js';
import type { ConfigUser } from './config.js';
import { ApiError } from './errors.js';
import { locate } from './files.js';

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

const tickets = new Map<string, { user: string; until: number }>();

export function issueTerminalTicket(username: string): string {
  const now = Date.now();
  for (const [key, row] of tickets) {
    if (row.until < now) tickets.delete(key);
  }
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { user: username, until: now + 60_000 });
  return ticket;
}

export function takeTerminalTicket(ticket: string, username: string): boolean {
  const row = tickets.get(ticket);
  if (!row || row.until < Date.now()) {
    if (row) tickets.delete(ticket);
    return false;
  }
  if (row.user !== username) return false;
  tickets.delete(ticket);
  return true;
}

export async function folderRealPath(user: ConfigUser, rootId: string, rel: string): Promise<string> {
  const root = await requireRoot(user, rootId, 'view');
  const located = await locate(root.abs, rel, 'read');
  if (!located.real || located.outside || !located.isDir) throw new ApiError(404, 'not_found', 'That folder is not there.');
  return fs.realpath(located.real);
}

function openShell(ws: WebSocket, username: string, cwd: string, rootId: string, rel: string) {
  const windows = process.platform === 'win32';
  let pty: IPty;
  try {
    pty = spawn(windows ? 'powershell.exe' : 'bash', windows ? ['-NoLogo'] : ['-il'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: shellEnv(),
    });
  } catch (error) {
    ws.send(`\r\nCould not open a shell. ${error instanceof Error ? error.message : ''}\r\n`);
    ws.close();
    return;
  }
  void logActivity({ user: username, action: 'terminal', root: rootId, path: rel });
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
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/api/terminal') {
    socket.destroy();
    return;
  }
  const user = await readSession(sessionId(request.headers.cookie));
  const ticket = url.searchParams.get('ticket') ?? '';
  if (!user?.admin || !takeTerminalTicket(ticket, user.username)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const rootId = url.searchParams.get('root') ?? '';
  const rel = url.searchParams.get('path') ?? '';
  let cwd = os.homedir();
  let loggedRoot = '';
  let loggedPath = '';
  if (rootId) {
    try {
      cwd = await folderRealPath(user, rootId, rel);
      loggedRoot = rootId;
      loggedPath = rel;
    } catch {
      cwd = os.homedir();
    }
  }
  sockets.handleUpgrade(request, socket, head, (ws) => openShell(ws, user.username, cwd, loggedRoot, loggedPath));
}
