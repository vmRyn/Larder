import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { findUser, runtime, type ConfigUser } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

let dummyHash = '';

export async function warmAuth() {
  if (!dummyHash) dummyHash = await hashPassword('larder-not-a-password');
}

export function timingHash(): string {
  return dummyHash;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = encoded.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const key = (await scrypt(password, Buffer.from(saltHex, 'hex'), 32)) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

function sessionsDir() {
  return path.join(runtime().dataDir, 'sessions');
}

export async function createSession(username: string): Promise<string> {
  const id = crypto.randomBytes(32).toString('hex');
  const record = { username, created: new Date().toISOString(), expires: Date.now() + SESSION_MS, secret: runtime().config.sessionSecret };
  await fs.writeFile(path.join(sessionsDir(), id), JSON.stringify(record), 'utf8');
  return id;
}

export async function readSession(id: string | undefined): Promise<ConfigUser | null> {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const file = path.join(sessionsDir(), id);
  let record: { username: string; expires: number; secret: string };
  try {
    record = JSON.parse(await fs.readFile(file, 'utf8')) as { username: string; expires: number; secret: string };
  } catch {
    return null;
  }
  if (record.secret !== runtime().config.sessionSecret || record.expires < Date.now()) {
    await fs.unlink(file).catch(() => undefined);
    return null;
  }
  const user = findUser(record.username);
  if (!user || user.disabled) {
    await fs.unlink(file).catch(() => undefined);
    return null;
  }
  record.expires = Date.now() + SESSION_MS;
  await fs.writeFile(file, JSON.stringify(record), 'utf8');
  return user;
}

export async function destroySession(id: string | undefined) {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return;
  await fs.unlink(path.join(sessionsDir(), id)).catch(() => undefined);
}

export async function destroyUserSessions(username: string) {
  const dir = sessionsDir();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8')) as { username?: string };
        if (record.username === username) await fs.unlink(file);
      } catch {
        /* ignore unreadable session files */
      }
    }),
  );
}

export type LiveSession = { id: string; username: string; created: string; expires: number };

async function readLiveSession(name: string): Promise<LiveSession | null> {
  if (!/^[a-f0-9]{64}$/.test(name)) return null;
  try {
    const file = path.join(sessionsDir(), name);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as { username?: string; created?: string; expires?: number; secret?: string };
    if (!record.username || record.secret !== runtime().config.sessionSecret || (record.expires ?? 0) < Date.now()) return null;
    const created = record.created ?? (await fs.stat(file)).mtime.toISOString();
    return { id: name, username: record.username, created, expires: record.expires ?? 0 };
  } catch {
    return null;
  }
}

export async function listUserSessions(username: string): Promise<LiveSession[]> {
  const names = await fs.readdir(sessionsDir()).catch(() => [] as string[]);
  const sessions: LiveSession[] = [];
  for (const name of names) {
    const session = await readLiveSession(name);
    if (session?.username === username) sessions.push(session);
  }
  sessions.sort((a, b) => b.expires - a.expires);
  return sessions;
}

export async function sessionCounts(): Promise<Map<string, number>> {
  const dir = sessionsDir();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const counts = new Map<string, number>();
  const now = Date.now();
  const secret = runtime().config.sessionSecret;
  for (const name of names) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { username?: string; expires?: number; secret?: string };
      if (!record.username || record.secret !== secret || (record.expires ?? 0) < now) continue;
      counts.set(record.username, (counts.get(record.username) ?? 0) + 1);
    } catch {
      /* ignore unreadable session files */
    }
  }
  return counts;
}

const attempts = new Map<string, { n: number; until: number }>();

export function loginWait(key: string): number {
  const row = attempts.get(key);
  if (!row) return 0;
  return Math.max(0, row.until - Date.now());
}

export function loginFailed(key: string): number {
  const row = attempts.get(key) ?? { n: 0, until: 0 };
  row.n += 1;
  if (row.n >= 5) row.until = Date.now() + Math.min(60_000, 1000 * 2 ** (row.n - 5));
  attempts.set(key, row);
  return Math.max(0, row.until - Date.now());
}

export function loginSucceeded(key: string) {
  attempts.delete(key);
}
