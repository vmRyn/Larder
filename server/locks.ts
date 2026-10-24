import fs from 'node:fs/promises';
import path from 'node:path';
import { hashPassword, verifyPassword } from './auth.js';
import { runtime } from './config.js';
import { ApiError } from './errors.js';
import { locate } from './files.js';
import { safeSegments } from './paths.js';

export class LockedError extends ApiError {
  constructor(public lockPath: string) {
    super(401, 'locked', 'This folder needs a password.');
  }
}

export class LockDenied extends ApiError {
  constructor(message: string, public retryAfterMs = 0) {
    super(retryAfterMs > 0 ? 429 : 401, retryAfterMs > 0 ? 'rate_limited' : 'unauthorized', message);
  }
}

type LockRecord = { root: string; path: string; passwordHash: string };
type Store = { locks: LockRecord[] };

let lock: Promise<void> = Promise.resolve();
const unlocks = new Map<string, Set<string>>();
const attempts = new Map<string, { n: number; until: number }>();

function file() {
  return path.join(runtime().dataDir, 'locks.json');
}

function clean(rel: string): string {
  return safeSegments(rel).join('/');
}

function unlockKey(rootId: string, rel: string) {
  return `${rootId}\0${clean(rel)}`;
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8')) as Store;
    return { locks: Array.isArray(parsed.locks) ? parsed.locks : [] };
  } catch {
    return { locks: [] };
  }
}

function update(run: (store: Store) => Promise<void> | void): Promise<void> {
  const next = lock.then(async () => {
    const store = await readStore();
    await run(store);
    const tmp = `${file()}.tmp`;
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(tmp, file());
  });
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function attemptKey(sessionId: string, rootId: string, rel: string) {
  return `${sessionId}\0${rootId}\0${clean(rel)}`;
}

function waitLeft(key: string) {
  const row = attempts.get(key);
  if (!row) return 0;
  return Math.max(0, row.until - Date.now());
}

function failed(key: string) {
  const row = attempts.get(key) ?? { n: 0, until: 0 };
  row.n += 1;
  if (row.n >= 5) row.until = Date.now() + Math.min(60_000, 1000 * 2 ** (row.n - 5));
  attempts.set(key, row);
  return Math.max(0, row.until - Date.now());
}

function succeeded(key: string) {
  attempts.delete(key);
}

function isUnlocked(sessionId: string, rootId: string, rel: string) {
  return unlocks.get(sessionId)?.has(unlockKey(rootId, rel)) ?? false;
}

export function clearUnlocks(sessionId: string | undefined) {
  if (sessionId) unlocks.delete(sessionId);
}

export function blockingLock(sessionId: string, locks: LockRecord[], rootId: string, rel: string, includeSelf: boolean): string | null {
  const parts = clean(rel).split('/').filter(Boolean);
  let acc = '';
  for (let i = 0; i < parts.length; i += 1) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
    if (!includeSelf && i === parts.length - 1) continue;
    const hit = locks.find((item) => item.root === rootId && item.path === acc);
    if (hit && !isUnlocked(sessionId, rootId, acc)) return acc;
  }
  return null;
}

export async function assertOpen(sessionId: string, rootId: string, rel: string, deep = false) {
  const locks = (await readStore()).locks;
  const self = blockingLock(sessionId, locks, rootId, rel, true);
  if (self) throw new LockedError(self);
  if (!deep) return;
  const base = clean(rel);
  for (const item of locks) {
    if (item.root !== rootId || item.path === base) continue;
    const inside = base ? item.path.startsWith(`${base}/`) : Boolean(item.path);
    if (inside && !isUnlocked(sessionId, rootId, item.path)) throw new LockedError(item.path);
  }
}

export async function lockedNames(rootId: string, parent: string): Promise<Set<string>> {
  const prefix = clean(parent);
  const names = new Set<string>();
  for (const item of (await readStore()).locks) {
    if (item.root !== rootId) continue;
    const rest = prefix ? (item.path.startsWith(`${prefix}/`) ? item.path.slice(prefix.length + 1) : '') : item.path;
    if (rest && !rest.includes('/')) names.add(rest);
  }
  return names;
}

export async function searchHidden(sessionId: string, rootId: string, rel: string): Promise<boolean> {
  const locks = (await readStore()).locks;
  return blockingLock(sessionId, locks, rootId, rel, false) != null;
}

async function requireFolder(rootAbs: string, rel: string) {
  const folder = clean(rel);
  if (!folder) throw new ApiError(400, 'invalid_name', 'Choose a folder.');
  const located = await locate(rootAbs, folder, 'read');
  if (!located.exists || located.outside || !located.isDir) throw new ApiError(400, 'invalid_name', 'Choose a folder.');
  return folder;
}

export async function setFolderPassword(sessionId: string, rootId: string, rootAbs: string, rel: string, password: string, current: string) {
  const folder = await requireFolder(rootAbs, rel);
  if (!password || password.length > 200) throw new ApiError(400, 'invalid_name', 'Enter a password.');
  const key = attemptKey(sessionId, rootId, folder);
  const existing = (await readStore()).locks.find((item) => item.root === rootId && item.path === folder);
  if (existing) {
    const wait = waitLeft(key);
    if (wait > 0) throw new LockDenied('That password is wrong.', wait);
    if (!(await verifyPassword(current, existing.passwordHash))) {
      throw new LockDenied('That password is wrong.', failed(key));
    }
    succeeded(key);
  }
  const passwordHash = await hashPassword(password);
  await update((store) => {
    const row = store.locks.find((item) => item.root === rootId && item.path === folder);
    if (row) row.passwordHash = passwordHash;
    else store.locks.unshift({ root: rootId, path: folder, passwordHash });
  });
}

export async function clearFolderPassword(sessionId: string, rootId: string, rel: string, current: string) {
  const folder = clean(rel);
  const key = attemptKey(sessionId, rootId, folder);
  const existing = (await readStore()).locks.find((item) => item.root === rootId && item.path === folder);
  if (!existing) return;
  const wait = waitLeft(key);
  if (wait > 0) throw new LockDenied('That password is wrong.', wait);
  if (!(await verifyPassword(current, existing.passwordHash))) {
    throw new LockDenied('That password is wrong.', failed(key));
  }
  succeeded(key);
  await update((store) => {
    store.locks = store.locks.filter((item) => !(item.root === rootId && item.path === folder));
  });
  for (const set of unlocks.values()) set.delete(unlockKey(rootId, folder));
}

export async function unlockFolder(sessionId: string, rootId: string, rootAbs: string, rel: string, password: string) {
  const folder = await requireFolder(rootAbs, rel);
  const existing = (await readStore()).locks.find((item) => item.root === rootId && item.path === folder);
  if (!existing) return;
  const key = attemptKey(sessionId, rootId, folder);
  const wait = waitLeft(key);
  if (wait > 0) throw new LockDenied('That password is wrong.', wait);
  if (!(await verifyPassword(password, existing.passwordHash))) {
    throw new LockDenied('That password is wrong.', failed(key));
  }
  succeeded(key);
  const set = unlocks.get(sessionId) ?? new Set<string>();
  set.add(unlockKey(rootId, folder));
  unlocks.set(sessionId, set);
}

function rewrite(value: string, from: string, to: string): string | null {
  if (value === from) return to;
  if (from && value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  return null;
}

export async function retargetLock(fromRoot: string, fromPath: string, toRoot: string, toPath: string) {
  const from = clean(fromPath);
  const to = clean(toPath);
  if (!from || from === to && fromRoot === toRoot) return;
  await update((store) => {
    for (const item of store.locks) {
      if (item.root !== fromRoot) continue;
      const next = rewrite(item.path, from, to);
      if (next == null) continue;
      item.root = toRoot;
      item.path = next;
    }
  });
  for (const set of unlocks.values()) {
    for (const key of [...set]) {
      const split = key.indexOf('\0');
      const root = key.slice(0, split);
      const rel = key.slice(split + 1);
      if (root !== fromRoot) continue;
      const next = rewrite(rel, from, to);
      if (next == null) continue;
      set.delete(key);
      set.add(`${toRoot}\0${next}`);
    }
  }
}
