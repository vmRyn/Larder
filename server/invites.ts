import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { assertPassword, assertUsername, findUser, runtime, updateConfig, type Access } from './config.js';
import { ApiError } from './errors.js';

export type Invite = {
  id: string;
  grants: Record<string, Access>;
  admin: boolean;
  home: boolean;
  expires: number;
  created: string;
  note: string;
};

type Store = { invites: Invite[] };

let lock: Promise<void> = Promise.resolve();

function file() {
  return path.join(runtime().dataDir, 'invites.json');
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8')) as Store;
    return { invites: Array.isArray(parsed.invites) ? parsed.invites : [] };
  } catch {
    return { invites: [] };
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

export async function listInvites(): Promise<Invite[]> {
  const now = Date.now();
  return (await readStore()).invites.filter((invite) => invite.expires > now);
}

export async function createInvite(grants: Record<string, Access>, admin: boolean, home: boolean, days: number, note: string): Promise<Invite> {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new ApiError(400, 'invalid_name', 'An invite lasts between 1 and 30 days.');
  if (home && !runtime().config.homes.enabled) {
    throw new ApiError(400, 'not_configured', 'Turn on homes in the config file before giving someone a vault.');
  }
  const invite: Invite = {
    id: crypto.randomBytes(16).toString('hex'),
    grants,
    admin,
    home,
    expires: Date.now() + days * 24 * 60 * 60 * 1000,
    created: new Date().toISOString(),
    note: note.trim().slice(0, 200),
  };
  await update((store) => {
    store.invites.unshift(invite);
  });
  return invite;
}

export async function revokeInvite(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(404, 'not_found', 'That invite is not there.');
  let removed = false;
  await update((store) => {
    const before = store.invites.length;
    store.invites = store.invites.filter((invite) => invite.id !== id);
    removed = store.invites.length !== before;
  });
  if (!removed) throw new ApiError(404, 'not_found', 'That invite is not there.');
}

export async function readInvite(id: string): Promise<Invite | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const invite = (await readStore()).invites.find((item) => item.id === id);
  if (!invite || invite.expires <= Date.now()) return null;
  return invite;
}

export async function acceptInvite(id: string, username: string, password: string, displayName: string): Promise<void> {
  assertUsername(username);
  assertPassword(password);
  const invite = await readInvite(id);
  if (!invite) throw new ApiError(404, 'not_found', 'That invite is not there.');
  const name = displayName.trim().slice(0, 80) || username;
  const passwordHash = await hashPassword(password);
  let used = false;
  await update(async (store) => {
    const current = store.invites.find((item) => item.id === id && item.expires > Date.now());
    if (!current) return;
    await updateConfig((config) => {
      if (config.users.some((item) => item.username === username)) {
        throw new ApiError(409, 'conflict', 'That username is already in use.');
      }
      config.users.push({
        username,
        displayName: name,
        passwordHash,
        admin: current.admin,
        disabled: false,
        home: current.home,
        grants: current.grants,
      });
    });
    store.invites = store.invites.filter((item) => item.id !== id);
    used = true;
  });
  if (!used || !findUser(username)) throw new ApiError(404, 'not_found', 'That invite is not there.');
}
