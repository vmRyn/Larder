import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { runtime } from './config.js';
import { ApiError } from './errors.js';
import { locate, placeName, rootReal } from './files.js';
import { isInside, safeSegments } from './paths.js';
import { scanFile } from './scan.js';
import { ensureFolder } from './upload.js';

export type PendingUpload = {
  id: string;
  username: string;
  root: string;
  dest: string;
  name: string;
  size: number;
  offset: number;
};

export class ResumeAt extends Error {
  constructor(public offset: number) {
    super('The upload continued from the wrong place.');
    this.name = 'ResumeAt';
  }
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.then(run, run);
  locks.set(id, next.then(() => undefined, () => undefined));
  return next;
}

function dir() {
  return path.join(runtime().dataDir, 'uploads');
}

function metaPath(id: string) {
  return path.join(dir(), `${id}.json`);
}

function partPath(id: string) {
  return path.join(dir(), `${id}.part`);
}

function assertId(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(404, 'not_found', 'That upload is not there.');
}

async function readMeta(id: string): Promise<PendingUpload | null> {
  assertId(id);
  try {
    return JSON.parse(await fs.readFile(metaPath(id), 'utf8')) as PendingUpload;
  } catch {
    return null;
  }
}

async function writeMeta(meta: PendingUpload) {
  await fs.mkdir(dir(), { recursive: true });
  const tmp = `${metaPath(meta.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta), 'utf8');
  await fs.rename(tmp, metaPath(meta.id));
}

function sameFile(meta: PendingUpload, username: string, root: string, dest: string, name: string, size: number) {
  return meta.username === username && meta.root === root && meta.dest === dest && meta.name === name && meta.size === size;
}

export async function openUpload(
  username: string,
  root: string,
  dest: string,
  name: string,
  size: number,
  requestedId: string | undefined,
  maxBytes: number,
): Promise<PendingUpload> {
  const segments = safeSegments(name);
  if (segments.length === 0) throw new ApiError(400, 'invalid_name', 'That name cannot be used.');
  if (!Number.isInteger(size) || size < 0) throw new ApiError(400, 'invalid_name', 'That file size is not valid.');
  if (size > maxBytes) throw new ApiError(413, 'too_large', 'That file is over the upload limit.');
  safeSegments(dest);
  if (requestedId && /^[a-f0-9]{32}$/.test(requestedId)) {
    const existing = await readMeta(requestedId);
    if (existing && sameFile(existing, username, root, dest, name, size)) return existing;
  }
  const meta: PendingUpload = {
    id: crypto.randomBytes(16).toString('hex'),
    username,
    root,
    dest: safeSegments(dest).join('/'),
    name: segments.join('/'),
    size,
    offset: 0,
  };
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(partPath(meta.id), Buffer.alloc(0));
  await writeMeta(meta);
  return meta;
}

export async function uploadStatus(username: string, id: string): Promise<PendingUpload> {
  const meta = await readMeta(id);
  if (!meta || meta.username !== username) throw new ApiError(404, 'not_found', 'That upload is not there.');
  return meta;
}

export async function appendUpload(username: string, id: string, offset: number, stream: Readable): Promise<number> {
  return withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta || meta.username !== username) throw new ApiError(404, 'not_found', 'That upload is not there.');
    const part = partPath(id);
    const st = await fs.stat(part).catch(() => null);
    if (!st) throw new ApiError(404, 'not_found', 'That upload is not there.');
    if (st.size > meta.offset) await fs.truncate(part, meta.offset);
    if (st.size < meta.offset) {
      meta.offset = st.size;
      await writeMeta(meta);
    }
    if (offset !== meta.offset) throw new ResumeAt(meta.offset);
    if (meta.offset > meta.size) throw new ApiError(413, 'too_large', 'That file is over the upload limit.');
    const handle = await fs.open(part, 'a');
    let written = 0;
    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (meta.offset + written + buf.length > meta.size) {
          throw new ApiError(413, 'too_large', 'That file is over the upload limit.');
        }
        await handle.write(buf);
        written += buf.length;
      }
    } catch (error) {
      await handle.close();
      await fs.truncate(part, meta.offset).catch(() => undefined);
      throw error;
    }
    await handle.close();
    meta.offset += written;
    await writeMeta(meta);
    return meta.offset;
  });
}

export async function finishUpload(username: string, id: string, rootAbs: string, onConflict?: 'replace' | 'keep'): Promise<string> {
  return withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta || meta.username !== username) throw new ApiError(404, 'not_found', 'That upload is not there.');
    const part = partPath(id);
    const st = await fs.stat(part);
    if (st.size !== meta.size || meta.offset !== meta.size) {
      throw new ApiError(409, 'conflict', 'That upload is not finished.');
    }
    const segments = safeSegments(meta.name);
    const parentRel = [...safeSegments(meta.dest), ...segments.slice(0, -1)].join('/');
    await ensureFolder(rootAbs, parentRel);
    const parent = await locate(rootAbs, parentRel, 'read');
    if (!parent.real || !parent.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
    const leaf = segments.at(-1)!;
    const chosen = await placeName(parent.real, leaf, onConflict);
    if (onConflict === 'replace') {
      const existing = path.join(parent.real, chosen);
      const current = await fs.lstat(existing).catch(() => null);
      if (current?.isDirectory()) throw new ApiError(409, 'conflict', `${chosen} is a folder.`);
    }
    const finalAbs = path.join(parent.real, chosen);
    const jail = await rootReal(rootAbs);
    if (!isInside(jail, finalAbs)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
    try {
      await scanFile(part);
    } catch (error) {
      await fs.unlink(part).catch(() => undefined);
      await fs.unlink(metaPath(id)).catch(() => undefined);
      throw error;
    }
    try {
      await fs.rename(part, finalAbs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') throw error;
      await fs.copyFile(part, finalAbs);
      await fs.unlink(part);
    }
    await fs.unlink(metaPath(id)).catch(() => undefined);
    return [...safeSegments(meta.dest), ...segments.slice(0, -1), chosen].filter(Boolean).join('/');
  });
}

export async function cancelUpload(username: string, id: string) {
  return withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta || meta.username !== username) throw new ApiError(404, 'not_found', 'That upload is not there.');
    await fs.unlink(partPath(id)).catch(() => undefined);
    await fs.unlink(metaPath(id)).catch(() => undefined);
  });
}
