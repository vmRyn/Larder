import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashPassword, verifyPassword } from './auth.js';
import { findUser, runtime, type ConfigUser } from './config.js';
import { ApiError } from './errors.js';
import { locate, readBytes } from './files.js';
import { requireRoot } from './access.js';

export type ShareRecord = {
  id: string;
  root: string;
  path: string;
  name: string;
  owner: string;
  passwordHash: string | null;
  expires: number | null;
  created: string;
  zip: boolean;
  note: string;
  opens: number;
  lastOpen: string | null;
};

type Store = { shares: ShareRecord[] };

let lock: Promise<void> = Promise.resolve();
const attempts = new Map<string, { n: number; until: number }>();

function file() {
  return path.join(runtime().dataDir, 'shares.json');
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8')) as Store;
    return { shares: Array.isArray(parsed.shares) ? parsed.shares : [] };
  } catch {
    return { shares: [] };
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

export type PublicShare = {
  id: string;
  root: string;
  path: string;
  name: string;
  owner: string;
  expires: number | null;
  created: string;
  hasPassword: boolean;
  zip: boolean;
  note: string;
  opens: number;
  lastOpen: string | null;
};

function publish(share: ShareRecord): PublicShare {
  return {
    id: share.id,
    root: share.root,
    path: share.path,
    name: share.name,
    owner: share.owner,
    expires: share.expires,
    created: share.created,
    hasPassword: Boolean(share.passwordHash),
    zip: Boolean(share.zip),
    note: typeof share.note === 'string' ? share.note : '',
    opens: Number.isInteger(share.opens) ? share.opens : 0,
    lastOpen: typeof share.lastOpen === 'string' ? share.lastOpen : null,
  };
}

export function validShareId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id) || (/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id) && id.length >= 2);
}

function shareAddress(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!id) return crypto.randomBytes(16).toString('hex');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id) || id.length < 2) {
    throw new ApiError(400, 'invalid_name', 'Use 2–32 letters, digits, and hyphens.');
  }
  return id;
}

function cleanNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length > 200) throw new ApiError(400, 'invalid_name', 'That note is too long.');
  return trimmed;
}

function expiryFromDays(days: number | null): number | null {
  if (days == null) return null;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new ApiError(400, 'invalid_name', 'Choose an expiry between 1 and 365 days.');
  }
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

export async function listShares(user: ConfigUser): Promise<PublicShare[]> {
  const store = await readStore();
  return store.shares.filter((share) => user.admin || share.owner === user.username).map(publish);
}

export async function createShare(user: ConfigUser, rootId: string, rel: string, password: string, days: number | null, note = '', address = ''): Promise<PublicShare> {
  const root = await requireRoot(user, rootId, 'view');
  const located = await locate(root.abs, rel, 'read');
  if (!located.exists || located.outside) throw new ApiError(404, 'not_found', 'That file is not there.');
  const zip = located.isDir;
  const fileInfo = zip ? null : await readBytes(root.abs, rel);
  if (password.length > 200) throw new ApiError(400, 'invalid_name', 'That password is too long.');
  const share: ShareRecord = {
    id: shareAddress(address),
    root: root.id,
    path: rel,
    name: fileInfo?.name ?? `${path.basename(rel) || 'folder'}.zip`,
    owner: user.username,
    passwordHash: password ? await hashPassword(password) : null,
    expires: expiryFromDays(days),
    created: new Date().toISOString(),
    zip,
    note: cleanNote(note),
    opens: 0,
    lastOpen: null,
  };
  await update((store) => {
    if (store.shares.some((item) => item.id === share.id)) {
      throw new ApiError(409, 'conflict', 'That address is already in use.');
    }
    store.shares.unshift(share);
  });
  return publish(share);
}

export async function updateShare(
  user: ConfigUser,
  id: string,
  patch: { note?: string; password?: string; clearPassword?: boolean; days?: number | null },
): Promise<PublicShare> {
  if (!validShareId(id)) throw new ApiError(404, 'not_found', 'That link is not there.');
  if (patch.password != null && patch.password.length > 200) throw new ApiError(400, 'invalid_name', 'That password is too long.');
  const note = patch.note === undefined ? undefined : cleanNote(patch.note);
  const expires = patch.days === undefined ? undefined : expiryFromDays(patch.days);
  const passwordHash = patch.clearPassword ? null : patch.password ? await hashPassword(patch.password) : undefined;
  let published: PublicShare | null = null;
  await update((store) => {
    const share = store.shares.find((item) => item.id === id);
    if (!share || (!user.admin && share.owner !== user.username)) return;
    if (note !== undefined) share.note = note;
    if (expires !== undefined) share.expires = expires;
    if (passwordHash !== undefined) share.passwordHash = passwordHash;
    share.opens ??= 0;
    share.lastOpen ??= null;
    published = publish(share);
  });
  if (!published) throw new ApiError(404, 'not_found', 'That link is not there.');
  return published;
}

export async function recordOpen(id: string): Promise<string> {
  let note = '';
  await update((store) => {
    const share = store.shares.find((item) => item.id === id);
    if (!share || (share.expires != null && share.expires <= Date.now())) return;
    share.opens = (Number.isInteger(share.opens) ? share.opens : 0) + 1;
    share.lastOpen = new Date().toISOString();
    note = typeof share.note === 'string' ? share.note : '';
  });
  return note;
}

export async function revokeShare(user: ConfigUser, id: string) {
  if (!validShareId(id)) throw new ApiError(404, 'not_found', 'That link is not there.');
  let removed = false;
  await update((store) => {
    const share = store.shares.find((item) => item.id === id);
    if (!share || (!user.admin && share.owner !== user.username)) return;
    store.shares = store.shares.filter((item) => item.id !== id);
    removed = true;
  });
  if (!removed) throw new ApiError(404, 'not_found', 'That link is not there.');
}

export function shareWait(id: string): number {
  const row = attempts.get(id);
  if (!row || row.until <= Date.now()) return 0;
  return row.until - Date.now();
}

function shareFailed(id: string) {
  const row = attempts.get(id) ?? { n: 0, until: 0 };
  row.n += 1;
  if (row.n >= 5) row.until = Date.now() + Math.min(60_000, 2_000 * (row.n - 4));
  attempts.set(id, row);
}

function shareSucceeded(id: string) {
  attempts.delete(id);
}

export async function describeShare(id: string): Promise<{ name: string; hasPassword: boolean; zip: boolean } | null> {
  if (!validShareId(id)) return null;
  const share = (await readStore()).shares.find((item) => item.id === id);
  if (!share || (share.expires != null && share.expires <= Date.now())) return null;
  return { name: share.name, hasPassword: Boolean(share.passwordHash), zip: Boolean(share.zip) };
}

export async function openShare(
  id: string,
  password: string | null,
  unlocked = false,
): Promise<{ abs: string; name: string; needsPassword: boolean; zipRoot: string; zipPath: string }> {
  if (!validShareId(id)) throw new ApiError(404, 'not_found', 'This link is not available.');
  const share = (await readStore()).shares.find((item) => item.id === id);
  if (!share || (share.expires != null && share.expires <= Date.now())) {
    throw new ApiError(404, 'not_found', 'This link is not available.');
  }
  if (share.passwordHash && !unlocked) {
    if (password == null) return { abs: '', name: share.name, needsPassword: true, zipRoot: '', zipPath: '' };
    const wait = shareWait(id);
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Try again in a moment.');
    if (!(await verifyPassword(password, share.passwordHash))) {
      shareFailed(id);
      throw new ApiError(401, 'unauthorized', 'That password is wrong.');
    }
    shareSucceeded(id);
  }
  const owner = findUser(share.owner);
  if (!owner || owner.disabled) throw new ApiError(404, 'not_found', 'This link is not available.');
  try {
    const root = await requireRoot(owner, share.root, 'view');
    const located = await locate(root.abs, share.path, 'read');
    if (!located.exists || located.outside) throw new ApiError(404, 'not_found', 'That file is not there.');
    if (share.zip || located.isDir) {
      const name = share.name.toLowerCase().endsWith('.zip') ? share.name : `${share.name}.zip`;
      return { abs: '', name, needsPassword: false, zipRoot: root.abs, zipPath: share.path };
    }
    const file = await readBytes(root.abs, share.path);
    return { abs: file.abs, name: share.name, needsPassword: false, zipRoot: '', zipPath: '' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new ApiError(404, 'not_found', 'This link is not available.');
    throw new ApiError(404, 'not_found', 'This link is not available.');
  }
}
