import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireRoot, visibleRoots } from './access.js';
import { logActivity, latestByUser, readActivity } from './activity.js';
import {
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  loginFailed,
  loginSucceeded,
  loginWait,
  readSession,
  listUserSessions,
  sessionCounts,
  timingHash,
  verifyPassword,
} from './auth.js';
import {
  assertPassword,
  assertUsername,
  findUser,
  publicUser,
  resolveConfigPath,
  runtime,
  updateConfig,
  type Access,
  type ConfigUser,
} from './config.js';
import { ApiError } from './errors.js';
import { safeZipEntryName } from './paths.js';
import { favoritesFor, setFavorite } from './favorites.js';
import {
  collectForZip,
  copyEntries,
  emptyTrash,
  folderSize,
  purgeExpiredTrash,
  followFile,
  listDirectory,
  listTrash,
  locate,
  makeDirectory,
  makeFile,
  moveEntries,
  moveToTrash,
  readBytes,
  renameEntry,
  restoreTrash,
  saveText,
  searchNames,
} from './files.js';
import { canPreview, fileResponse, isAudioFile, isImageFile, isTextFile, mediaType, previewKind, readPreviewText } from './send.js';
import { heicJpeg, isHeicFile, isVideoFile, makeThumb, makeVideoThumb, mediaDuration, receiveUpload, sha256File } from './upload.js';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
import { appendUpload, cancelUpload, finishUpload, openUpload, ResumeAt, uploadStatus } from './resume.js';
import { createShare, describeShare, listShares, openShare, recordOpen, revokeShare, updateShare } from './shares.js';
import { acceptInvite, createInvite, listInvites, readInvite, revokeInvite } from './invites.js';
import { sampleHost } from './host.js';
import { clamCommand } from './scan.js';
import { csvTable, markdownHtml } from './rich.js';
import { extractZip, listZipEntries, readZipEntry, saveZip, zipStream } from './zip.js';

type AppEnv = { Bindings: { incoming?: IncomingMessage } };

const COOKIE = 'larder_session';

function diskLow(freeBytes: number, totalBytes: number): boolean {
  if (totalBytes > 0 && freeBytes / totalBytes < 0.1) return true;
  return freeBytes < 5 * 1024 * 1024 * 1024;
}

function frameHeaders(c: Context) {
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Content-Security-Policy', "frame-ancestors 'self'");
}

async function renewSession(c: Context<AppEnv>, username: string) {
  await destroyUserSessions(username);
  setCookie(c, COOKIE, await createSession(username), cookieOptions(c));
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requestUrl(c: Context<AppEnv>): URL {
  const url = new URL(c.req.url);
  const remote = c.env?.incoming?.socket?.remoteAddress;
  if (isLoopback(remote) && c.req.header('x-forwarded-proto') === 'https') url.protocol = 'https:';
  return url;
}

function cookieOptions(c: Context<AppEnv>) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: requestUrl(c).protocol === 'https:',
    maxAge: 60 * 60 * 24 * 7,
  };
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_name', 'The request was not valid.');
  }
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiError(400, 'invalid_name', 'The request was not valid.');
  }
  return value as string[];
}

function conflictMode(value: unknown): 'replace' | 'keep' | undefined {
  if (value === 'replace' || value === 'keep') return value;
  return undefined;
}

function addressOf(c: Context<AppEnv>): string {
  const remote = c.env?.incoming?.socket?.remoteAddress ?? '';
  if (isLoopback(remote)) {
    const forwarded = c.req.header('cf-connecting-ip')?.trim() ?? '';
    if (/^[0-9a-fA-F:.]+$/.test(forwarded)) return forwarded;
  }
  return remote || 'local';
}

async function signedIn(c: Context): Promise<ConfigUser> {
  const user = await readSession(getCookie(c, COOKIE));
  if (!user) throw new ApiError(401, 'unauthorized', 'You need to sign in.');
  return user;
}

async function admin(c: Context): Promise<ConfigUser> {
  const user = await signedIn(c);
  if (!user.admin) throw new ApiError(403, 'forbidden', 'You need an admin account for that.');
  return user;
}

function groupIds(value: unknown, groups: { id: string }[]): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ApiError(400, 'invalid_name', 'Choose groups from the list.');
  const known = new Set(groups.map((group) => group.id));
  const ids = [...new Set(value.map((item) => String(item)))];
  if (ids.some((id) => !known.has(id))) throw new ApiError(400, 'invalid_name', 'That group is not there.');
  return ids;
}

function groupSlug(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new ApiError(400, 'invalid_name', 'Use a name with letters and digits.');
  return id;
}

function parseGrants(value: unknown): Record<string, Access> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const ids = new Set(runtime().config.roots.map((root) => root.id));
  const grants: Record<string, Access> = {};
  for (const [id, access] of Object.entries(value as Record<string, unknown>)) {
    if (!ids.has(id)) throw new ApiError(400, 'invalid_name', 'That folder is not configured.');
    if (access !== 'view' && access !== 'edit') throw new ApiError(400, 'invalid_name', 'Access is view or edit.');
    grants[id] = access;
  }
  return grants;
}

async function sessionBody(user: ConfigUser) {
  const { roots, warnings } = await visibleRoots(user);
  return {
    state: 'ready' as const,
    user: { username: user.username, displayName: user.displayName || user.username, admin: user.admin },
    roots: roots.map(({ id, name, access, freeBytes, totalBytes }) => ({ id, name, access, freeBytes, totalBytes })),
    homesEnabled: runtime().config.homes.enabled,
    warnings,
  };
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    frameHeaders(c);
    if (error instanceof ApiError) {
      return c.json({ error: error.message, code: error.code }, error.status as 400);
    }
    console.error(error);
    return c.json({ error: 'Something went wrong.', code: 'error' }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    frameHeaders(c);
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-larder-request') !== '1') {
      throw new ApiError(403, 'forbidden', 'This action was refused.');
    }
    await next();
  });

  app.get('/api/session', async (c) => {
    if (runtime().config.users.length === 0) return c.json({ state: 'setup' });
    const user = await readSession(getCookie(c, COOKIE));
    if (!user) return c.json({ state: 'login' });
    return c.json(await sessionBody(user));
  });

  app.post('/api/setup', async (c) => {
    const body = await readJson(c);
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    assertUsername(username);
    assertPassword(password);
    const passwordHash = await hashPassword(password);
    await updateConfig((config) => {
      if (config.users.length > 0) throw new ApiError(403, 'forbidden', 'This server already has an account.');
      config.users.push({
        username,
        displayName: username,
        passwordHash,
        admin: true,
        disabled: false,
        home: false,
        grants: {},
      });
    });
    const id = await createSession(username);
    setCookie(c, COOKIE, id, cookieOptions(c));
    await logActivity({ user: username, action: 'login', root: '', path: '' });
    return c.json({ ok: true });
  });

  app.post('/api/login', async (c) => {
    const body = await readJson(c);
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    const key = `${username}:${addressOf(c)}`;
    const wait = loginWait(key);
    if (wait > 0) {
      return c.json({ error: 'Wrong username or password.', code: 'rate_limited', retryAfterMs: wait }, 429);
    }
    const user = findUser(username);
    const ok = await verifyPassword(password, user?.passwordHash ?? timingHash());
    if (!user || user.disabled || !ok) {
      const retryAfterMs = loginFailed(key);
      await logActivity({ user: username || 'unknown', action: 'login_failed', root: '', path: '' });
      return c.json(
        { error: 'Wrong username or password.', code: retryAfterMs ? 'rate_limited' : 'unauthorized', retryAfterMs },
        401,
      );
    }
    loginSucceeded(key);
    const id = await createSession(user.username);
    setCookie(c, COOKIE, id, cookieOptions(c));
    await logActivity({ user: user.username, action: 'login', root: '', path: '' });
    return c.json({ ok: true });
  });

  app.post('/api/logout', async (c) => {
    await destroySession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/api/password', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const next = String(body.next ?? '');
    assertPassword(next);
    if (!(await verifyPassword(String(body.current ?? ''), user.passwordHash))) {
      throw new ApiError(403, 'forbidden', 'Wrong password.');
    }
    const passwordHash = await hashPassword(next);
    await updateConfig((config) => {
      const found = config.users.find((item) => item.username === user.username);
      if (found) found.passwordHash = passwordHash;
    });
    await renewSession(c, user.username);
    return c.json({ ok: true });
  });

  app.get('/api/users', async (c) => {
    await admin(c);
    const config = runtime().config;
    const [sessions, seen] = await Promise.all([sessionCounts(), latestByUser()]);
    const homesAbs = config.homes.enabled && config.homes.path ? resolveConfigPath(runtime().configPath, config.homes.path) : null;
    const users = await Promise.all(
      config.users.map(async (user) => {
        let homeBytes: number | null = null;
        let homeFiles: number | null = null;
        if (user.home && homesAbs) {
          try {
            const sized = await folderSize(path.join(homesAbs, user.username), '');
            homeBytes = sized.bytes;
            homeFiles = sized.files;
          } catch {
            homeBytes = null;
            homeFiles = null;
          }
        }
        const last = seen.get(user.username);
        return {
          ...publicUser(user),
          sessions: sessions.get(user.username) ?? 0,
          lastSeen: last?.t ?? null,
          lastAction: last?.action ?? null,
          homeBytes,
          homeFiles,
        };
      }),
    );
    return c.json({
      users,
      roots: config.roots.map(({ id, name }) => ({ id, name })),
      homesEnabled: config.homes.enabled,
      groups: (config.groups ?? []).map((group) => ({
        ...group,
        members: config.users.filter((user) => (user.groups ?? []).includes(group.id)).length,
      })),
    });
  });

  app.post('/api/users', async (c) => {
    const actor = await admin(c);
    const body = await readJson(c);
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    assertUsername(username);
    assertPassword(password);
    const displayName = String(body.displayName ?? username).trim().slice(0, 80) || username;
    const grants = parseGrants(body.grants);
    const home = Boolean(body.home);
    if (home && !runtime().config.homes.enabled) {
      throw new ApiError(400, 'not_configured', 'Turn on homes in the config file before giving someone a vault.');
    }
    const passwordHash = await hashPassword(password);
    await updateConfig((config) => {
      if (config.users.some((item) => item.username === username)) {
        throw new ApiError(409, 'conflict', 'That username is already in use.');
      }
      config.users.push({
        username,
        displayName,
        passwordHash,
        admin: Boolean(body.admin),
        disabled: false,
        home,
        grants,
        groups: groupIds(body.groups, config.groups ?? []),
      });
    });
    if (home) await requireRoot(findUser(username)!, `home:${username}`, 'view').catch(() => undefined);
    await logActivity({ user: actor.username, action: 'user', root: '', path: username });
    return c.json(publicUser(findUser(username)!));
  });

  app.patch('/api/users/:username', async (c) => {
    const actor = await admin(c);
    const username = c.req.param('username');
    const body = await readJson(c);
    await updateConfig((config) => {
      const found = config.users.find((item) => item.username === username);
      if (!found) throw new ApiError(404, 'not_found', 'That account is not there.');
      const nextAdmin = body.admin === undefined ? found.admin : Boolean(body.admin);
      const nextDisabled = body.disabled === undefined ? found.disabled : Boolean(body.disabled);
      const remaining = config.users.filter((item) => item.username !== username && item.admin && !item.disabled).length;
      if (found.admin && !found.disabled && (!nextAdmin || nextDisabled) && remaining === 0) {
        throw new ApiError(403, 'forbidden', 'The last admin cannot be removed.');
      }
      if (actor.username === username && nextDisabled) {
        throw new ApiError(403, 'forbidden', 'You cannot disable the account you are using.');
      }
      if (body.displayName !== undefined) found.displayName = String(body.displayName).trim().slice(0, 80) || found.username;
      found.admin = nextAdmin;
      found.disabled = nextDisabled;
      if (body.home !== undefined) {
        if (Boolean(body.home) && !config.homes.enabled) {
          throw new ApiError(400, 'not_configured', 'Turn on homes in the config file before giving someone a vault.');
        }
        found.home = Boolean(body.home);
      }
      if (body.grants !== undefined) found.grants = parseGrants(body.grants);
      if (body.groups !== undefined) found.groups = groupIds(body.groups, config.groups ?? []);
    });
    const updated = findUser(username)!;
    if (updated.disabled) await destroyUserSessions(username);
    return c.json(publicUser(updated));
  });

  app.get('/api/users/:username/sessions', async (c) => {
    await admin(c);
    const username = c.req.param('username');
    if (!findUser(username)) throw new ApiError(404, 'not_found', 'That account is not there.');
    const sessions = await listUserSessions(username);
    const currentId = getCookie(c, COOKIE);
    return c.json({ sessions: sessions.map(({ id, created, expires }) => ({ id, created, expires, current: id === currentId })) });
  });

  app.delete('/api/users/:username/sessions/:id', async (c) => {
    await admin(c);
    const username = c.req.param('username');
    const id = c.req.param('id');
    const sessions = await listUserSessions(username);
    if (!sessions.some((session) => session.id === id)) throw new ApiError(404, 'not_found', 'That session is not there.');
    await destroySession(id);
    return c.json({ ok: true });
  });

  app.get('/api/invites', async (c) => {
    await admin(c);
    return c.json({ invites: await listInvites() });
  });

  app.post('/api/invites', async (c) => {
    await admin(c);
    const body = await readJson(c);
    const days = body.days == null || body.days === '' ? 7 : Number(body.days);
    const invite = await createInvite(parseGrants(body.grants), Boolean(body.admin), Boolean(body.home), days, String(body.note ?? ''));
    await logActivity({ user: (await admin(c)).username, action: 'user', root: '', path: 'invite' });
    return c.json(invite);
  });

  app.delete('/api/invites/:id', async (c) => {
    await admin(c);
    await revokeInvite(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/health', async (c) => {
    await admin(c);
    const config = runtime().config;
    const disks = config.roots.map((root) => ({ id: root.id, name: root.name, path: root.path }));
    if (config.homes.enabled && config.homes.path) disks.push({ id: 'homes', name: 'Vaults', path: config.homes.path });
    const roots = await Promise.all(
      disks.map(async (root) => {
        const abs = resolveConfigPath(runtime().configPath, root.path);
        try {
          const stats = await fs.statfs(abs);
          const block = Number(stats.bsize);
          const freeBytes = Number(stats.bavail) * block;
          const totalBytes = Number(stats.blocks) * block;
          return { id: root.id, name: root.name, path: abs, ok: true, freeBytes, totalBytes, low: diskLow(freeBytes, totalBytes) };
        } catch {
          return { id: root.id, name: root.name, path: abs, ok: false, freeBytes: null, totalBytes: null, low: false };
        }
      }),
    );
    const uploadDir = path.join(runtime().dataDir, 'uploads');
    const uploadNames = await fs.readdir(uploadDir).catch(() => [] as string[]);
    let uploadBytes = 0;
    let uploadCount = 0;
    for (const name of uploadNames) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(uploadDir, name), 'utf8')) as { size?: number };
        uploadCount += 1;
        uploadBytes += meta.size ?? 0;
      } catch {
        /* skip a broken upload record */
      }
    }
    const activityFile = path.join(runtime().dataDir, 'activity.jsonl');
    const activityBytes = await fs.stat(activityFile).then((st) => st.size).catch(() => 0);
    const clam = (await clamCommand()) ? 'installed' : 'missing';
    const host = await sampleHost();
    return c.json({ roots, shares: (await listShares(await admin(c))).length, uploads: { count: uploadCount, bytes: uploadBytes }, activityBytes, clam, host });
  });

  app.post('/api/users/:username/password', async (c) => {
    const actor = await admin(c);
    const username = c.req.param('username');
    const body = await readJson(c);
    const password = String(body.password ?? '');
    assertPassword(password);
    const passwordHash = await hashPassword(password);
    await updateConfig((config) => {
      const found = config.users.find((item) => item.username === username);
      if (!found) throw new ApiError(404, 'not_found', 'That account is not there.');
      found.passwordHash = passwordHash;
    });
    if (actor.username === username) await renewSession(c, username);
    else await destroyUserSessions(username);
    return c.json({ ok: true });
  });

  app.get('/api/activity', async (c) => {
    await admin(c);
    const offset = Number(c.req.query('offset') ?? '0');
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json(await readActivity(offset, limit));
  });

  app.get('/api/list', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const listed = await listDirectory(root.abs, c.req.query('path') ?? '', c.req.query('sort') ?? 'name', c.req.query('dir') ?? 'asc');
    return c.json(listed);
  });

  app.get('/api/download', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const file = await readBytes(root.abs, c.req.query('path') ?? '');
    return fileResponse(file.abs, file.name, c.req.raw, false);
  });

  app.get('/api/raw', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const rel = c.req.query('path') ?? '';
    const file = await readBytes(root.abs, rel);
    if (!canPreview(file.name)) throw new ApiError(403, 'forbidden', 'This file can be downloaded, not previewed.');
    if (isHeicFile(file.name)) {
      const st = await fs.stat(file.abs);
      const key = crypto.createHash('sha256').update(`${root.id}\0${rel}\0${st.size}\0${Math.round(st.mtimeMs)}`).digest('hex');
      const jpeg = await heicJpeg(file.abs, path.join(runtime().dataDir, 'thumbnails'), key);
      return fileResponse(jpeg, 'preview.jpg', c.req.raw, true);
    }
    return fileResponse(file.abs, file.name, c.req.raw, true);
  });

  app.put('/api/content', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const rel = String(body.path ?? '');
    if (!isTextFile(rel)) throw new ApiError(400, 'invalid_name', 'This file cannot be edited as text.');
    await saveText(root.abs, rel, String(body.text ?? ''), Number(body.mtime));
    await logActivity({ user: user.username, action: 'edit', root: root.id, path: rel });
    const file = await readBytes(root.abs, rel);
    const st = await fs.stat(file.abs);
    return c.json({ mtime: st.mtimeMs });
  });

  app.get('/api/follow', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const rel = c.req.query('path') ?? '';
    if (!isTextFile(rel)) throw new ApiError(400, 'invalid_name', 'Follow is for text files.');
    const offset = Number(c.req.query('offset') ?? '-1');
    return c.json(await followFile(root.abs, rel, offset));
  });

  app.get('/api/thumb', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const rel = c.req.query('path') ?? '';
    const base = path.basename(rel);
    const video = isVideoFile(base);
    if (!isImageFile(base) && !video) throw new ApiError(404, 'not_found', 'No thumbnail for this file.');
    const file = await readBytes(root.abs, rel);
    const st = await fs.stat(file.abs);
    const key = crypto.createHash('sha256').update(`${root.id}\0${rel}\0${st.size}\0${Math.round(st.mtimeMs)}`).digest('hex');
    try {
      const thumb = video
        ? await makeVideoThumb(file.abs, path.join(runtime().dataDir, 'thumbnails'), key)
        : await makeThumb(file.abs, path.join(runtime().dataDir, 'thumbnails'), key);
      return fileResponse(thumb, 'thumb.jpg', c.req.raw, true);
    } catch {
      throw new ApiError(404, 'not_found', 'No thumbnail for this file.');
    }
  });

  app.get('/api/search', async (c) => {
    const user = await signedIn(c);
    const numberQuery = (name: string) => {
      const raw = c.req.query(name);
      if (raw == null || raw === '') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const filter = {
      type: c.req.query('type') || undefined,
      minSize: numberQuery('min'),
      maxSize: numberQuery('max'),
      after: numberQuery('after'),
      before: numberQuery('before'),
    };
    const hidden = c.req.query('hidden') === '1';
    const query = c.req.query('q') ?? '';
    if (c.req.query('all') === '1') {
      const { roots } = await visibleRoots(user);
      const results: { path: string; kind: string; symlinkTo?: 'file' | 'dir'; outside?: boolean; size: number | null; mtime: number | null; root: string; rootName: string }[] = [];
      for (const root of roots) {
        if (results.length >= 500) break;
        const found = await searchNames(root.abs, '', query, hidden, filter);
        for (const item of found) {
          if (results.length >= 500) break;
          results.push({ ...item, root: root.id, rootName: root.name });
        }
      }
      return c.json({ results });
    }
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const results = await searchNames(root.abs, c.req.query('path') ?? '', query, hidden, filter);
    return c.json({ results });
  });

  app.get('/api/size', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    return c.json(await folderSize(root.abs, c.req.query('path') ?? ''));
  });

  app.get('/api/checksum', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const file = await readBytes(root.abs, c.req.query('path') ?? '');
    return c.json({ sha256: await sha256File(file.abs) });
  });

  app.post('/api/upload', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'edit');
    const incoming = c.env?.incoming;
    if (!incoming) throw new ApiError(400, 'invalid_name', 'Upload is not available.');
    const dest = c.req.query('path') ?? '';
    const result = await receiveUpload(incoming, root.abs, dest, conflictMode(c.req.query('onConflict')), runtime().config.maxUploadBytes);
    for (const saved of result.saved) await logActivity({ user: user.username, action: 'upload', root: root.id, path: saved });
    return c.json(result);
  });

  app.post('/api/uploads', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const size = Number(body.size);
    const pending = await openUpload(
      user.username,
      root.id,
      String(body.path ?? ''),
      String(body.name ?? ''),
      size,
      typeof body.id === 'string' ? body.id : undefined,
      runtime().config.maxUploadBytes,
    );
    return c.json({ id: pending.id, offset: pending.offset, size: pending.size });
  });

  app.get('/api/uploads/:id', async (c) => {
    const user = await signedIn(c);
    const pending = await uploadStatus(user.username, c.req.param('id'));
    return c.json({ id: pending.id, offset: pending.offset, size: pending.size });
  });

  app.put('/api/uploads/:id', async (c) => {
    const user = await signedIn(c);
    const offset = Number(c.req.header('x-larder-offset'));
    if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'invalid_name', 'That upload position is not valid.');
    const body = c.req.raw.body;
    const stream = body ? Readable.fromWeb(body as import('node:stream/web').ReadableStream) : Readable.from([]);
    try {
      const next = await appendUpload(user.username, c.req.param('id'), offset, stream);
      return c.json({ offset: next });
    } catch (error) {
      if (error instanceof ResumeAt) return c.json({ error: error.message, code: 'conflict', offset: error.offset }, 409);
      throw error;
    }
  });

  app.post('/api/uploads/:id/finish', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const pending = await uploadStatus(user.username, c.req.param('id'));
    const root = await requireRoot(user, pending.root, 'edit');
    const saved = await finishUpload(user.username, pending.id, root.abs, conflictMode(body.onConflict));
    await logActivity({ user: user.username, action: 'upload', root: root.id, path: saved });
    return c.json({ saved: [saved] });
  });

  app.delete('/api/uploads/:id', async (c) => {
    const user = await signedIn(c);
    await cancelUpload(user.username, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/mkdir', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const rel = String(body.path ?? '');
    const entry = await makeDirectory(root.abs, rel, String(body.name ?? ''));
    const full = rel ? `${rel}/${entry.name}` : entry.name;
    await logActivity({ user: user.username, action: 'mkdir', root: root.id, path: full });
    return c.json(entry);
  });

  app.post('/api/create-file', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const rel = String(body.path ?? '');
    const entry = await makeFile(root.abs, rel, String(body.name ?? ''));
    const full = rel ? `${rel}/${entry.name}` : entry.name;
    await logActivity({ user: user.username, action: 'create', root: root.id, path: full });
    return c.json(entry);
  });

  app.post('/api/rename', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const rel = String(body.path ?? '');
    const name = await renameEntry(root.abs, rel, String(body.name ?? ''));
    const parent = rel.split('/').slice(0, -1).join('/');
    const full = parent ? `${parent}/${name}` : name;
    await logActivity({ user: user.username, action: 'rename', root: root.id, path: full });
    return c.json({ name, path: full });
  });

  app.post('/api/copy', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const source = await requireRoot(user, String(body.root ?? ''), 'edit');
    const dest = body.toRoot ? await requireRoot(user, String(body.toRoot), 'edit') : source;
    const copied = await copyEntries(source.abs, strings(body.paths), String(body.to ?? ''), conflictMode(body.onConflict), dest.abs);
    const action = body.duplicate ? 'duplicate' : 'copy';
    for (const item of copied) await logActivity({ user: user.username, action, root: dest.id, path: item });
    return c.json({ copied });
  });

  app.post('/api/move', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const source = await requireRoot(user, String(body.root ?? ''), 'edit');
    const dest = body.toRoot ? await requireRoot(user, String(body.toRoot), 'edit') : source;
    const moved = await moveEntries(source.abs, strings(body.paths), String(body.to ?? ''), dest.abs);
    for (const item of moved) await logActivity({ user: user.username, action: 'move', root: dest.id, path: item });
    return c.json({ moved });
  });

  app.post('/api/delete', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const deleted = await moveToTrash(root.abs, strings(body.paths), user.username);
    for (const item of deleted) await logActivity({ user: user.username, action: 'trash', root: root.id, path: item });
    return c.json({ deleted });
  });

  app.post('/api/zip', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const wantSave = Boolean(body.save);
    const root = await requireRoot(user, String(body.root ?? ''), wantSave ? 'edit' : 'view');
    const paths = strings(body.paths);
    if (paths.length === 0) throw new ApiError(400, 'invalid_name', 'Choose something to zip.');
    if (wantSave) {
      const saved = await saveZip(root.abs, paths, runtime().config.maxUploadBytes);
      await logActivity({ user: user.username, action: 'zip', root: root.id, path: saved });
      return c.json({ path: saved });
    }
    const files = await collectForZip(root.abs, paths);
    const label = paths.length === 1 ? `${path.basename(paths[0]!)}.zip` : 'larder.zip';
    await logActivity({ user: user.username, action: 'zip', root: root.id, path: paths[0] ?? '' });
    const archive = zipStream(files);
    return new Response(Readable.toWeb(archive) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${label.replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  app.post('/api/extract', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const rel = String(body.path ?? '');
    const folder = await extractZip(root.abs, rel, runtime().config.maxUploadBytes);
    await logActivity({ user: user.username, action: 'extract', root: root.id, path: folder });
    return c.json({ folder });
  });

  app.get('/api/favorites', async (c) => {
    const user = await signedIn(c);
    const saved = await favoritesFor(user.username);
    const visible = [];
    for (const item of saved) {
      try {
        const root = await requireRoot(user, item.root, 'view');
        const located = await locate(root.abs, item.path, 'read');
        if (located.isDir && !located.outside) visible.push(item);
      } catch {
        /* drop pins the account can no longer open */
      }
    }
    return c.json({ favorites: visible });
  });

  app.put('/api/favorites', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'view');
    const rel = String(body.path ?? '');
    const located = await locate(root.abs, rel, 'read');
    if (!located.isDir || located.outside) throw new ApiError(400, 'invalid_name', 'Pin a folder.');
    await setFavorite(user.username, { root: root.id, path: rel }, Boolean(body.pinned));
    return c.json({ ok: true });
  });

  app.get('/api/trash', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'edit');
    await purgeExpiredTrash();
    const items = await listTrash(root.abs);
    const offset = Math.max(0, Number(c.req.query('offset') ?? '0') || 0);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '100') || 100));
    return c.json({ items: items.slice(offset, offset + limit), total: items.length, trashDays: runtime().config.trashDays ?? null });
  });

  app.put('/api/trash/policy', async (c) => {
    await admin(c);
    const body = await readJson(c);
    const days = body.days === null || body.days === '' ? null : Number(body.days);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) {
      throw new ApiError(400, 'invalid_name', 'Choose between 1 and 365 days, or keep trash until it is emptied.');
    }
    await updateConfig((config) => {
      config.trashDays = days;
    });
    await purgeExpiredTrash();
    return c.json({ trashDays: days });
  });

  app.post('/api/trash/restore', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    const restored = await restoreTrash(root.abs, String(body.id ?? ''), conflictMode(body.onConflict));
    await logActivity({ user: user.username, action: 'restore', root: root.id, path: restored });
    return c.json({ path: restored });
  });

  app.post('/api/trash/empty', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const root = await requireRoot(user, String(body.root ?? ''), 'edit');
    await emptyTrash(root.abs);
    await logActivity({ user: user.username, action: 'empty_trash', root: root.id, path: '' });
    return c.json({ ok: true });
  });

  app.get('/api/about', async (c) => {
    await signedIn(c);
    return c.json({ version });
  });

  app.get('/api/duration', async (c) => {
    const user = await signedIn(c);
    const root = await requireRoot(user, c.req.query('root') ?? '', 'view');
    const rel = c.req.query('path') ?? '';
    const base = path.basename(rel);
    if (!isVideoFile(base) && !isAudioFile(base)) throw new ApiError(404, 'not_found', 'This file has no length.');
    const file = await readBytes(root.abs, rel);
    const st = await fs.stat(file.abs);
    const key = crypto.createHash('sha256').update(`${root.id}\0${rel}\0${st.size}\0${Math.round(st.mtimeMs)}`).digest('hex');
    const seconds = await mediaDuration(file.abs, path.join(runtime().dataDir, 'thumbnails'), key);
    if (seconds == null) throw new ApiError(404, 'not_found', 'This file has no length.');
    return c.json({ seconds });
  });

  app.get('/api/groups', async (c) => {
    await admin(c);
    const config = runtime().config;
    return c.json({
      groups: (config.groups ?? []).map((group) => ({
        ...group,
        members: config.users.filter((user) => (user.groups ?? []).includes(group.id)).length,
      })),
    });
  });

  app.post('/api/groups', async (c) => {
    await admin(c);
    const body = await readJson(c);
    const name = String(body.name ?? '').trim().slice(0, 80);
    const id = groupSlug(name);
    const grants = parseGrants(body.grants);
    await updateConfig((config) => {
      config.groups ??= [];
      if (config.groups.some((group) => group.id === id)) throw new ApiError(409, 'conflict', 'That group already exists.');
      config.groups.push({ id, name, grants });
    });
    return c.json({ id, name, grants, members: 0 });
  });

  app.patch('/api/groups/:id', async (c) => {
    await admin(c);
    const id = c.req.param('id');
    const body = await readJson(c);
    let saved: { id: string; name: string; grants: Record<string, Access> } | undefined;
    await updateConfig((config) => {
      const group = (config.groups ?? []).find((item) => item.id === id);
      if (!group) throw new ApiError(404, 'not_found', 'That group is not there.');
      if (body.name !== undefined) group.name = String(body.name).trim().slice(0, 80) || group.name;
      if (body.grants !== undefined) group.grants = parseGrants(body.grants);
      saved = { id: group.id, name: group.name, grants: group.grants };
    });
    return c.json(saved);
  });

  app.delete('/api/groups/:id', async (c) => {
    await admin(c);
    const id = c.req.param('id');
    await updateConfig((config) => {
      const groups = config.groups ?? [];
      if (!groups.some((group) => group.id === id)) throw new ApiError(404, 'not_found', 'That group is not there.');
      config.groups = groups.filter((group) => group.id !== id);
      for (const user of config.users) user.groups = (user.groups ?? []).filter((group) => group !== id);
    });
    return c.json({ ok: true });
  });

  app.get('/api/shares', async (c) => {
    const user = await signedIn(c);
    return c.json({ shares: await listShares(user) });
  });

  app.post('/api/shares', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const days = body.days == null || body.days === '' ? null : Number(body.days);
    const share = await createShare(user, String(body.root ?? ''), String(body.path ?? ''), String(body.password ?? ''), days, String(body.note ?? ''), String(body.address ?? ''));
    await logActivity({ user: user.username, action: 'share', root: share.root, path: share.path });
    return c.json(share);
  });

  app.patch('/api/shares/:id', async (c) => {
    const user = await signedIn(c);
    const body = await readJson(c);
    const days = body.days === undefined ? undefined : body.days == null || body.days === '' ? null : Number(body.days);
    const share = await updateShare(user, c.req.param('id'), {
      note: body.note === undefined ? undefined : String(body.note),
      password: body.password == null || body.password === '' ? undefined : String(body.password),
      clearPassword: Boolean(body.clearPassword),
      days,
    });
    return c.json(share);
  });

  app.get('/api/shares/:id/qr', async (c) => {
    const user = await signedIn(c);
    const id = c.req.param('id');
    const shares = await listShares(user);
    if (!shares.some((share) => share.id === id)) throw new ApiError(404, 'not_found', 'That link is not there.');
    const { default: QRCode } = await import('qrcode');
    const svg = await QRCode.toString(`${requestUrl(c).origin}/s/${id}`, { type: 'svg', margin: 1, color: { dark: '#ffffff', light: '#202020' } });
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, no-store' });
  });

  app.delete('/api/shares/:id', async (c) => {
    const user = await signedIn(c);
    const id = c.req.param('id');
    const shares = await listShares(user);
    const share = shares.find((item) => item.id === id);
    await revokeShare(user, id);
    if (share) await logActivity({ user: user.username, action: 'unshare', root: share.root, path: share.path });
    return c.json({ ok: true });
  });

  app.get('/s/:token/file', async (c) => {
    const id = c.req.param('token');
    const info = await describeShare(id);
    if (!info) return c.html(shareScreen({ kind: 'missing' }), 404);
    if (info.hasPassword && !shareCookieOk(c, id)) return c.html(shareScreen({ kind: 'password', name: info.name }), 401);
    try {
      const opened = await openShare(id, null, true);
      if (opened.zipRoot) {
        const files = await collectForZip(opened.zipRoot, [opened.zipPath]);
        const archive = zipStream(files);
        return new Response(Readable.toWeb(archive) as ReadableStream, { headers: shareDownloadHeaders(opened.name) });
      }
      return fileResponse(opened.abs, opened.name, c.req.raw, false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return c.html(shareScreen({ kind: 'missing' }), 404);
      throw error;
    }
  });

  app.get('/s/:token/entry', async (c) => {
    const id = c.req.param('token');
    const info = await describeShare(id);
    if (!info) return c.html(shareScreen({ kind: 'missing' }), 404);
    if (info.hasPassword && !shareCookieOk(c, id)) return c.html(shareScreen({ kind: 'password', name: info.name }), 401);
    const wanted = safeZipEntryName(c.req.query('name') ?? '');
    if (!wanted) return c.html(shareScreen({ kind: 'missing' }), 404);
    try {
      const opened = await openShare(id, null, true);
      return await shareEntryResponse(opened, wanted, c.req.raw, c.req.query('download') === '1');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return c.html(shareScreen({ kind: 'missing' }), 404);
      throw error;
    }
  });

  app.get('/s/:token/preview', async (c) => {
    const id = c.req.param('token');
    const info = await describeShare(id);
    if (!info) return c.html(shareScreen({ kind: 'missing' }), 404);
    if (info.hasPassword && !shareCookieOk(c, id)) return c.html(shareScreen({ kind: 'password', name: info.name }), 401);
    try {
      const opened = await openShare(id, null, true);
      const kind = opened.zipRoot ? 'none' : previewKind(opened.name);
      if (kind === 'image' && isHeicFile(opened.name)) {
        const st = await fs.stat(opened.abs);
        const key = crypto.createHash('sha256').update(`share\0${id}\0${st.size}\0${Math.round(st.mtimeMs)}`).digest('hex');
        const jpeg = await heicJpeg(opened.abs, path.join(runtime().dataDir, 'thumbnails'), key);
        return fileResponse(jpeg, 'preview.jpg', c.req.raw, true);
      }
      if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') {
        return fileResponse(opened.abs, opened.name, c.req.raw, true);
      }
      return c.html(shareScreen({ kind: 'missing' }), 404);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return c.html(shareScreen({ kind: 'missing' }), 404);
      throw error;
    }
  });

  app.get('/s/:token', async (c) => {
    const id = c.req.param('token');
    const info = await describeShare(id);
    if (!info) return c.html(shareScreen({ kind: 'missing' }), 404);
    if (info.hasPassword && !shareCookieOk(c, id)) return c.html(shareScreen({ kind: 'password', name: info.name }));
    try {
      return c.html(await readyShareHtml(id, info.name, info.zip));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return c.html(shareScreen({ kind: 'missing' }), 404);
      throw error;
    }
  });

  app.post('/s/:token', async (c) => {
    const id = c.req.param('token');
    const info = await describeShare(id);
    if (!info) return c.html(shareScreen({ kind: 'missing' }), 404);
    const password = new URLSearchParams(await c.req.text()).get('password') ?? '';
    try {
      await openShare(id, password, false);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 429)) {
        return c.html(shareScreen({ kind: 'password', name: info.name, message: error.message }), error.status as 401);
      }
      if (error instanceof ApiError && error.status === 404) return c.html(shareScreen({ kind: 'missing' }), 404);
      throw error;
    }
    setCookie(c, 'larder_share', shareGrant(id), {
      httpOnly: true,
      sameSite: 'Lax',
      path: `/s/${id}`,
      secure: requestUrl(c).protocol === 'https:',
      maxAge: 600,
    });
    try {
      return c.html(await readyShareHtml(id, info.name, info.zip));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return c.html(shareScreen({ kind: 'missing' }), 404);
      throw error;
    }
  });

  app.get('/join/:id', async (c) => {
    const invite = await readInvite(c.req.param('id'));
    if (!invite) return c.html(joinScreen({ missing: true }), 404);
    return c.html(joinScreen({ id: invite.id, note: invite.note }));
  });

  app.post('/join/:id', async (c) => {
    const id = c.req.param('id');
    const form = new URLSearchParams(await c.req.text());
    const username = form.get('username') ?? '';
    try {
      await acceptInvite(id, username, form.get('password') ?? '', form.get('displayName') ?? '');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'That invite could not be used.';
      const status = error instanceof ApiError ? error.status : 400;
      return c.html(joinScreen({ id, note: '', message }), status as 400);
    }
    const user = findUser(username);
    if (!user) return c.html(joinScreen({ missing: true }), 404);
    const sessionId = await createSession(user.username);
    setCookie(c, COOKIE, sessionId, cookieOptions(c));
    await logActivity({ user: user.username, action: 'user', root: '', path: username });
    return c.redirect('/');
  });

  if (process.env.NODE_ENV === 'production') {
    app.use('/*', serveStatic({ root: path.join(process.cwd(), 'dist', 'client') }));
    app.notFound(async (c) => {
      if (c.req.path.startsWith('/api')) return c.json({ error: 'That page is not there.', code: 'not_found' }, 404);
      const html = await fs.readFile(path.join(process.cwd(), 'dist', 'client', 'index.html'));
      return c.html(html.toString());
    });
  }

  return app;
}

function shareGrant(id: string): string {
  return crypto.createHmac('sha256', runtime().config.sessionSecret).update(id).digest('hex');
}

function shareCookieOk(c: Context, id: string): boolean {
  const given = getCookie(c, 'larder_share');
  if (!given) return false;
  const expected = shareGrant(id);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function shareDownloadHeaders(name: string): HeadersInit {
  const label = name.replace(/"/g, '');
  return {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${label}"`,
    'X-Content-Type-Options': 'nosniff',
  };
}

function joinScreen(view: { missing: true } | { id: string; note: string; message?: string }): string {
  const missing = 'missing' in view;
  const inner = missing
    ? '<h1>Larder</h1><p>This invite is not available.</p>'
    : `<h1>Create your account</h1>${view.note ? `<p>${shareText(view.note)}</p>` : '<p>Choose a username and a password.</p>'}${view.message ? `<p class="warn">${shareText(view.message)}</p>` : ''}<form method="post"><input name="username" placeholder="Username" autocomplete="username" required><input name="displayName" placeholder="Display name"><input type="password" name="password" placeholder="Password" autocomplete="new-password" required><button type="submit">Create account</button></form>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Larder</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #191919; color: #fff; font: 14px "Segoe UI", system-ui, sans-serif; }
  main { width: min(400px, calc(100% - 48px)); display: flex; flex-direction: column; gap: 12px; border: 1px solid #454545; border-radius: 8px; background: #202020; padding: 24px; }
  h1 { margin: 0; font-size: 20px; } p { margin: 0; color: #adadad; } .warn { color: #e81123; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input, button { height: 32px; border: 0; border-radius: 4px; }
  input { background: #2b2b2b; color: #fff; padding: 0 8px; }
  button { background: #60cdff; color: #06202b; cursor: pointer; }
</style><main>${inner}</main>`;
}

function shareText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

type SharePreview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image' | 'pdf' | 'video' | 'audio' }
  | { kind: 'zip'; entries: { name: string; size: number }[]; more: boolean }
  | { kind: 'none' };

const PREVIEW_LIST = 200;

async function readyShareHtml(id: string, name: string, zip: boolean): Promise<string> {
  const opened = await openShare(id, null, true);
  const note = await recordOpen(id).catch(() => '');
  let preview: SharePreview = { kind: 'none' };
  try {
    preview = await makeSharePreview(opened);
  } catch {
    preview = { kind: 'none' };
  }
  return shareScreen({ kind: 'ready', id, name, zip, preview, note });
}

async function makeSharePreview(opened: { abs: string; name: string; zipRoot: string; zipPath: string }): Promise<SharePreview> {
  if (opened.zipRoot) {
    const files = await collectForZip(opened.zipRoot, [opened.zipPath], PREVIEW_LIST + 1);
    const more = files.length > PREVIEW_LIST;
    const entries: { name: string; size: number }[] = [];
    for (const file of files.slice(0, PREVIEW_LIST)) {
      const st = await fs.stat(file.abs);
      entries.push({ name: file.name, size: st.size });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { kind: 'zip', entries, more };
  }
  const kind = previewKind(opened.name);
  if (kind === 'zip') {
    const listed = await listZipEntries(opened.abs, PREVIEW_LIST);
    listed.entries.sort((a, b) => a.name.localeCompare(b.name));
    return { kind: 'zip', entries: listed.entries, more: listed.more };
  }
  if (kind === 'text') return { kind: 'text', ...(await readPreviewText(opened.abs)) };
  if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') return { kind };
  return { kind: 'none' };
}

const TEXT_PREVIEW_CAP = 1024 * 1024;
const MEDIA_PREVIEW_CAP = 20 * 1024 * 1024;

function listedKind(name: string, size: number): 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'none' {
  const kind = previewKind(name);
  if (kind === 'text') return 'text';
  if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') {
    return size > MEDIA_PREVIEW_CAP ? 'none' : kind;
  }
  return 'none';
}

async function shareEntryResponse(
  opened: { abs: string; name: string; zipRoot: string; zipPath: string },
  wanted: string,
  request: Request,
  download: boolean,
): Promise<Response> {
  const kind = listedKind(wanted, 0);
  if (!download && kind === 'none') return sharePlain('This file can be downloaded, not previewed.', 404);
  if (download && opened.zipRoot) {
    const files = await collectForZip(opened.zipRoot, [opened.zipPath], PREVIEW_LIST + 1);
    const match = files.find((file) => file.name === wanted);
    if (!match) return sharePlain('This file is not in the zip.', 404);
    return fileResponse(match.abs, path.basename(wanted), request, false);
  }
  if (download && opened.abs && previewKind(opened.name) === 'zip') {
    const read = await readZipEntry(opened.abs, wanted, runtime().config.maxUploadBytes, false);
    if (!read) return sharePlain('This file is not in the zip.', 404);
    if ('tooBig' in read) return sharePlain('This file is too large to download from the preview.', 413);
    const headers = new Headers();
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${path.basename(wanted).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"`);
    headers.set('Content-Length', String(read.bytes.length));
    return new Response(new Uint8Array(read.bytes), { headers });
  }
  if (download) return sharePlain('This file is not in the zip.', 404);
  if (opened.zipRoot) {
    const files = await collectForZip(opened.zipRoot, [opened.zipPath], PREVIEW_LIST + 1);
    const match = files.find((file) => file.name === wanted);
    if (!match) return sharePlain('This file is not in the zip.', 404);
    if (kind === 'text') {
      const read = await readPreviewText(match.abs);
      return shareTextPreview(wanted, read.text, read.truncated);
    }
    const st = await fs.stat(match.abs);
    if (st.size > MEDIA_PREVIEW_CAP) return sharePlain('This file is too large to preview.', 413);
    return fileResponse(match.abs, path.basename(wanted), request, true);
  }
  if (!opened.abs || previewKind(opened.name) !== 'zip') return sharePlain('This file is not in the zip.', 404);
  const read = await readZipEntry(opened.abs, wanted, kind === 'text' ? TEXT_PREVIEW_CAP : MEDIA_PREVIEW_CAP, kind === 'text');
  if (!read) return sharePlain('This file is not in the zip.', 404);
  if ('tooBig' in read) return sharePlain('This file is too large to preview.', 413);
  if (kind === 'text') return shareTextPreview(wanted, read.bytes.toString('utf8'), read.truncated);
  const headers = new Headers();
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Type', mediaType(wanted));
  headers.set('Content-Disposition', `inline; filename="${path.basename(wanted).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Length', String(read.bytes.length));
  return new Response(new Uint8Array(read.bytes), { headers });
}

function shareTextPreview(name: string, text: string, truncated: boolean): Response {
  const lower = name.toLowerCase();
  const html = lower.endsWith('.md') ? markdownHtml(text) : lower.endsWith('.csv') ? csvTable(text) : '';
  if (!html) return sharePlain(text, 200, truncated);
  const headers = new Headers();
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  if (truncated) headers.set('X-Larder-Truncated', '1');
  return new Response(html, { headers });
}

function sharePlain(text: string, status: number, truncated = false): Response {
  const headers = new Headers();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  if (truncated) headers.set('X-Larder-Truncated', '1');
  return new Response(text, { status, headers });
}

function shareBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const digits = n >= 10 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[i]}`;
}

function sharePreviewHtml(id: string, fileName: string, preview: SharePreview): string {
  if (preview.kind === 'none') return '';
  if (preview.kind === 'text') {
    const more = preview.truncated ? '<p class="more">Showing the first 1 MB.</p>' : '';
    const lower = fileName.toLowerCase();
    const rich = lower.endsWith('.md') ? markdownHtml(preview.text) : lower.endsWith('.csv') ? csvTable(preview.text) : '';
    return `<div class="stage">${more}${rich || `<pre>${shareText(preview.text)}</pre>`}</div>`;
  }
  if (preview.kind === 'image') return `<div class="stage"><img src="/s/${id}/preview" alt=""></div>`;
  if (preview.kind === 'pdf') return `<div class="stage sheet"><iframe title="Preview" src="/s/${id}/preview"></iframe></div>`;
  if (preview.kind === 'video') return `<div class="stage"><video src="/s/${id}/preview" controls playsinline></video></div>`;
  if (preview.kind === 'audio') return `<div class="stage"><audio src="/s/${id}/preview" controls></audio></div>`;
  if (preview.kind !== 'zip') return '';
  if (preview.entries.length === 0) return '<div class="stage"><p class="empty">Nothing is in this zip.</p></div>';
  let first = -1;
  const rows = preview.entries
    .map((entry, index) => {
      const kind = listedKind(entry.name, entry.size);
      const pressed = first === -1 && kind !== 'none';
      if (pressed) first = index;
      const label = shareText(entry.name.replace(/[\r\n\t]/g, ' '));
      const href = `/s/${id}/entry?name=${encodeURIComponent(entry.name)}&download=1`;
      return `<li class="file-row"><button type="button" data-entry="${label}" data-kind="${kind}" aria-pressed="${pressed ? 'true' : 'false'}"><span class="name">${label}</span><span class="size">${shareBytes(entry.size)}</span></button><a class="file-dl" href="${href}">Save</a></li>`;
    })
    .join('');
  const opening = first === -1 ? null : preview.entries[first];
  const openKind = opening ? listedKind(opening.name, opening.size) : 'none';
  const openUrl = opening ? `/s/${id}/entry?name=${encodeURIComponent(opening.name)}` : '';
  let stage = '<p class="empty">Select a file to preview it.</p>';
  if (openKind === 'image') stage = `<img src="${openUrl}" alt="">`;
  else if (openKind === 'pdf') stage = `<iframe title="Preview" src="${openUrl}"></iframe>`;
  else if (openKind === 'video') stage = `<video src="${openUrl}" controls playsinline></video>`;
  else if (openKind === 'audio') stage = `<audio src="${openUrl}" controls></audio>`;
  const more = preview.more ? '<p class="more">There are more files than this list shows.</p>' : '';
  return `<div class="split"><div class="list"><ul class="files">${rows}</ul>${more}</div><div class="stage" id="stage">${stage}</div></div>${shareZipScript(id, openKind === 'text' ? opening?.name ?? '' : '')}`;
}

function shareZipScript(id: string, openText: string): string {
  return `<script>
(() => {
  const stage = document.getElementById('stage');
  const buttons = [...document.querySelectorAll('.files button')];
  const base = ${JSON.stringify(`/s/${id}/entry?name=`).replace(/</g, '\\u003c')};
  function show(button) {
    for (const item of buttons) item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
    const kind = button.dataset.kind || 'none';
    const url = base + encodeURIComponent(button.dataset.entry || '');
    stage.replaceChildren();
    if (kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.src = url;
      stage.append(img);
    } else if (kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.title = 'Preview';
      frame.src = url;
      stage.append(frame);
    } else if (kind === 'video' || kind === 'audio') {
      const media = document.createElement(kind);
      media.src = url;
      media.controls = true;
      if (kind === 'video') media.playsInline = true;
      stage.append(media);
    } else if (kind === 'text') {
      const name = (button.dataset.entry || '').toLowerCase();
      const rich = name.endsWith('.md') || name.endsWith('.csv');
      const box = document.createElement(rich ? 'div' : 'pre');
      if (rich) box.className = name.endsWith('.csv') ? 'table-wrap' : 'markdown';
      stage.append(box);
      fetch(url).then(async (response) => {
        const body = await response.text();
        if (rich && (response.headers.get('content-type') || '').includes('text/html')) box.innerHTML = body;
        else box.textContent = body;
        if (response.headers.get('x-larder-truncated') === '1') {
          const note = document.createElement('p');
          note.className = 'more';
          note.textContent = 'Showing the first 1 MB.';
          stage.append(note);
        }
      }).catch(() => { box.textContent = 'This file could not be previewed.'; });
    } else {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'This file can be downloaded with the zip, not previewed here.';
      stage.append(note);
    }
  }
  for (const button of buttons) button.addEventListener('click', () => show(button));
  const opening = ${JSON.stringify(openText).replace(/</g, '\\u003c')};
  const start = opening ? buttons.find((button) => button.dataset.entry === opening) : null;
  if (start) show(start);
})();
</script>`;
}

function shareScreen(
  view:
    | { kind: 'missing' }
    | { kind: 'password'; name: string; message?: string }
    | { kind: 'ready'; id: string; name: string; zip: boolean; preview: SharePreview; note: string },
): string {
  const title = view.kind === 'missing' ? 'Larder' : view.name;
  let inner = '';
  let wide = false;
  if (view.kind === 'missing') {
    inner = '<h1>Larder</h1><p>This link is not available.</p>';
  } else if (view.kind === 'password') {
    const warn = view.message ? `<p class="warn">${shareText(view.message)}</p>` : '';
    inner = `<h1>${shareText(view.name)}</h1><p>This file is shared with a password.</p>${warn}<form method="post"><input type="password" name="password" autocomplete="current-password" placeholder="Password" autofocus required><button type="submit">Continue</button></form>`;
  } else {
    const note = view.zip ? 'The download is a zip of the shared folder.' : 'This file was shared with you.';
    wide = view.preview.kind !== 'none';
    const caption = view.note ? `<p class="caption">${shareText(view.note)}</p>` : '';
    inner = `<header class="top"><img class="logo" src="/larder.png" width="40" height="40" alt=""><div class="titles"><h1>${shareText(view.name)}</h1><p>${note}</p>${caption}</div><a class="download" href="/s/${view.id}/file">Download</a></header>${sharePreviewHtml(view.id, view.name, view.preview)}`;
  }
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${shareText(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 28px 16px; background: #191919; color: #fff; font: 14px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }
  main { width: min(400px, 100%); display: flex; flex-direction: column; align-items: flex-start; gap: 12px; border: 1px solid #454545; border-radius: 8px; background: #202020; padding: 24px; box-shadow: 0 16px 40px rgb(0 0 0 / 0.35); }
  main.wide { width: min(960px, 100%); padding: 0; overflow: hidden; }
  .logo { border-radius: 4px; }
  .top { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 14px; padding: 16px 18px; border-bottom: 1px solid #2e2e2e; }
  .titles { min-width: 0; flex: 1; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; word-break: break-word; }
  p { margin: 0; color: #adadad; }
  .top p { margin-top: 2px; font-size: 13px; }
  .warn { color: #e81123; }
  .split { display: flex; min-height: 440px; }
  .list { width: 280px; flex: none; display: flex; flex-direction: column; border-right: 1px solid #2e2e2e; background: #1b1b1b; }
  ul.files { list-style: none; margin: 0; padding: 8px; overflow: auto; max-height: 480px; }
  ul.files button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; border: 0; border-radius: 4px; background: transparent; color: #fff; padding: 8px 10px; text-align: left; font: inherit; cursor: pointer; }
  ul.files button:hover { background: #2a2a2a; }
  ul.files button[aria-pressed="true"] { background: #333333; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .size { flex: none; color: #adadad; font-size: 12px; }
  .more { padding: 0 12px 10px; font-size: 12px; }
  .stage { flex: 1; min-width: 0; min-height: 440px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 20px; background: #191919; overflow: auto; }
  .stage .empty { text-align: center; }
  .stage img, .stage video { max-width: 100%; max-height: 480px; border-radius: 4px; }
  .stage pre { align-self: stretch; width: 100%; margin: 0; white-space: pre-wrap; word-break: break-word; font: 13px "Cascadia Mono", Consolas, ui-monospace, monospace; }
  .stage iframe { width: 100%; height: 480px; border: 0; border-radius: 4px; background: #fff; }
  .stage audio { width: min(420px, 100%); }
  .stage .more { padding: 8px 0 0; }
  form { display: flex; width: 100%; flex-direction: column; gap: 12px; }
  input, form button, .download { height: 32px; border: 0; border-radius: 4px; }
  input { background: #2b2b2b; color: #fff; padding: 0 8px; }
  form button, .download { display: inline-flex; flex: none; align-items: center; justify-content: center; background: #60cdff; color: #06202b; padding: 0 16px; font: inherit; text-decoration: none; cursor: pointer; }
  .caption { margin-top: 4px; color: #fff; }
  .file-row { display: flex; align-items: center; gap: 4px; }
  .file-row button { min-width: 0; flex: 1; }
  .file-dl { flex: none; color: #adadad; font-size: 12px; padding: 4px 6px; text-decoration: none; }
  .file-dl:hover { color: #fff; }
  .markdown, .table-wrap { align-self: stretch; width: 100%; }
  .markdown h1, .markdown h2, .markdown h3, .markdown p, .markdown ul { margin: 0 0 8px; }
  .markdown code { font-family: Consolas, ui-monospace, monospace; }
  .table-wrap { max-height: 480px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { border-bottom: 1px solid #2e2e2e; padding: 6px 8px; }
  @media (max-width: 720px) {
    .split { flex-direction: column; min-height: 0; }
    .list { width: auto; border-right: 0; border-bottom: 1px solid #2e2e2e; }
    ul.files { max-height: 220px; }
    .stage { min-height: 280px; }
  }
</style>
<main class="${wide ? 'wide' : 'narrow'}">
  ${inner}
</main>`;
}
