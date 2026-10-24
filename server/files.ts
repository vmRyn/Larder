import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfigPath, runtime } from './config.js';
import { ApiError } from './errors.js';
import { formatMode, isInside, nameError, safeSegments } from './paths.js';

export type Entry = {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  symlinkTo?: 'file' | 'dir';
  outside?: boolean;
  size: number | null;
  mtime: number | null;
  hidden: boolean;
  mode: string | null;
};

export type Located = {
  /** Path of the directory entry itself. Symlinks are not dereferenced here. */
  abs: string;
  /** Dereferenced path when it stays inside the root. */
  real: string | null;
  isLink: boolean;
  outside: boolean;
  exists: boolean;
  isDir: boolean;
};

export async function rootReal(root: string): Promise<string> {
  try {
    const real = await fs.realpath(root);
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new ApiError(404, 'not_found', 'That folder is not there.');
    return real;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, 'not_found', 'That folder is not there.');
  }
}

export async function locate(root: string, rel: string, mode: 'read' | 'create'): Promise<Located> {
  const base = await rootReal(root);
  const segments = safeSegments(rel);
  let dir = base;
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const next = path.join(dir, segments[i]!);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      st = await fs.lstat(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && last && mode === 'create') {
        if (!isInside(base, next)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
        return { abs: next, real: null, isLink: false, outside: false, exists: false, isDir: false };
      }
      throw new ApiError(404, 'not_found', 'That file is not there.');
    }
    if (st.isSymbolicLink()) {
      let real: string | null = null;
      let outside = true;
      let isDir = false;
      try {
        real = await fs.realpath(next);
        outside = !isInside(base, real);
        if (!outside) isDir = (await fs.stat(real)).isDirectory();
      } catch {
        outside = true;
        real = null;
      }
      if (last) {
        return { abs: next, real: outside ? null : real, isLink: true, outside, exists: true, isDir };
      }
      if (outside || !real || !isDir) {
        throw new ApiError(403, 'outside_root', 'This link points outside the folder Larder is allowed to use.');
      }
      dir = real;
      continue;
    }
    if (!isInside(base, next)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
    if (last) {
      return { abs: next, real: next, isLink: false, outside: false, exists: true, isDir: st.isDirectory() };
    }
    if (!st.isDirectory()) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
    dir = await fs.realpath(next);
    if (!isInside(base, dir)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
  }
  return { abs: dir, real: dir, isLink: false, outside: false, exists: true, isDir: true };
}

function requireInside(item: Located): string {
  if (!item.exists || item.outside || !item.real) {
    throw new ApiError(403, 'outside_root', 'This link points outside the folder Larder is allowed to use.');
  }
  return item.real;
}

export async function listDirectory(root: string, rel: string, sort: string, dir: string): Promise<{ path: string; entries: Entry[] }> {
  const located = await locate(root, rel, 'read');
  const abs = requireInside(located);
  if (!located.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const names = await fs.readdir(abs);
  const entries: Entry[] = [];
  for (const name of names) {
    if (name === '.larder-trash' || name.startsWith('.larder-upload-')) continue;
    const child = path.join(abs, name);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      st = await fs.lstat(child);
    } catch {
      continue;
    }
    const hidden = name.startsWith('.');
    if (st.isSymbolicLink()) {
      let outside = true;
      let symlinkTo: 'file' | 'dir' | undefined;
      let size: number | null = null;
      let mtime: number | null = st.mtimeMs;
      try {
        const real = await fs.realpath(child);
        outside = !isInside(await rootReal(root), real);
        if (!outside) {
          const followed = await fs.stat(real);
          symlinkTo = followed.isDirectory() ? 'dir' : 'file';
          size = followed.isDirectory() ? null : followed.size;
          mtime = followed.mtimeMs;
        }
      } catch {
        outside = true;
      }
      entries.push({ name, kind: 'symlink', symlinkTo, outside, size, mtime, hidden, mode: formatMode(st.mode) });
      continue;
    }
    entries.push({
      name,
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? null : st.size,
      mtime: st.mtimeMs,
      hidden,
      mode: formatMode(st.mode),
    });
  }
  const factor = dir === 'desc' ? -1 : 1;
  entries.sort((a, b) => {
    const aDir = a.kind === 'dir' || a.symlinkTo === 'dir' ? 0 : 1;
    const bDir = b.kind === 'dir' || b.symlinkTo === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    if (sort === 'size') return ((a.size ?? -1) - (b.size ?? -1)) * factor;
    if (sort === 'mtime') return ((a.mtime ?? 0) - (b.mtime ?? 0)) * factor;
    if (sort === 'type') {
      const ext = (entry: Entry) => (entry.kind === 'dir' || entry.symlinkTo === 'dir' ? '' : path.extname(entry.name).toLowerCase());
      const compared = ext(a).localeCompare(ext(b));
      if (compared !== 0) return compared * factor;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * factor;
  });
  return { path: safeSegments(rel).join('/'), entries };
}

export async function removeTree(abs: string, jail: string) {
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink()) {
    await fs.unlink(abs);
    return;
  }
  const real = await fs.realpath(abs);
  if (!isInside(jail, real)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
  if (st.isDirectory()) {
    const names = await fs.readdir(abs);
    for (const name of names) await removeTree(path.join(abs, name), jail);
    await fs.rmdir(abs);
    return;
  }
  await fs.unlink(abs);
}

async function namesIn(dir: string): Promise<Set<string>> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return new Set(names);
}

export async function placeName(dir: string, name: string, onConflict?: 'replace' | 'keep'): Promise<string> {
  const problem = nameError(name);
  if (problem) throw new ApiError(400, 'invalid_name', problem);
  const existing = await namesIn(dir);
  if (!existing.has(name)) return name;
  if (onConflict === 'keep') {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; i < 1000; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new ApiError(409, 'conflict', 'Too many files share that name.');
  }
  if (onConflict === 'replace') return name;
  throw new ApiError(409, 'conflict', `${name} is already here.`);
}

export async function makeDirectory(root: string, rel: string, name: string): Promise<Entry> {
  const parent = await locate(root, rel, 'read');
  const dir = requireInside(parent);
  if (!parent.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const chosen = await placeName(dir, name);
  const abs = path.join(dir, chosen);
  await fs.mkdir(abs);
  const st = await fs.stat(abs);
  return { name: chosen, kind: 'dir', size: null, mtime: st.mtimeMs, hidden: chosen.startsWith('.'), mode: formatMode(st.mode) };
}

export async function makeFile(root: string, rel: string, name: string): Promise<Entry> {
  const parent = await locate(root, rel, 'read');
  const dir = requireInside(parent);
  if (!parent.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const chosen = await placeName(dir, name);
  const abs = path.join(dir, chosen);
  await fs.writeFile(abs, '');
  const st = await fs.stat(abs);
  return { name: chosen, kind: 'file', size: 0, mtime: st.mtimeMs, hidden: chosen.startsWith('.'), mode: formatMode(st.mode) };
}

export async function renameEntry(root: string, rel: string, name: string) {
  const item = await locate(root, rel, 'read');
  if (!item.exists) throw new ApiError(404, 'not_found', 'That file is not there.');
  if (path.basename(item.abs) === name) return name;
  const dir = path.dirname(item.abs);
  const chosen = await placeName(dir, name);
  const dest = path.join(dir, chosen);
  if (!isInside(await rootReal(root), dest)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
  await fs.rename(item.abs, dest);
  return chosen;
}

async function copyNode(src: string, dest: string, jail: string, seen: Set<string>) {
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) {
    let real: string;
    try {
      real = await fs.realpath(src);
    } catch {
      return;
    }
    if (!isInside(jail, real) || seen.has(real)) return;
    const followed = await fs.stat(real);
    if (followed.isDirectory()) {
      seen.add(real);
      await fs.mkdir(dest, { recursive: true });
      for (const name of await fs.readdir(real)) await copyNode(path.join(real, name), path.join(dest, name), jail, seen);
      return;
    }
    await fs.copyFile(real, dest);
    return;
  }
  const real = await fs.realpath(src);
  if (!isInside(jail, real)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
  if (st.isDirectory()) {
    if (seen.has(real)) return;
    seen.add(real);
    await fs.mkdir(dest, { recursive: true });
    for (const name of await fs.readdir(src)) await copyNode(path.join(src, name), path.join(dest, name), jail, seen);
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function copyEntries(
  root: string,
  rels: string[],
  toRel: string,
  onConflict?: 'replace' | 'keep',
  destRoot?: string,
): Promise<string[]> {
  const sourceJail = await rootReal(root);
  const destJail = await rootReal(destRoot ?? root);
  const samePlace = sourceJail === destJail;
  const destDirLocated = await locate(destRoot ?? root, toRel, 'read');
  const destDir = requireInside(destDirLocated);
  if (!destDirLocated.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  if (!onConflict) {
    const existing = await namesIn(destDir);
    for (const rel of rels) {
      const item = await locate(root, rel, 'read');
      const base = path.basename(item.abs);
      if (existing.has(base)) throw new ApiError(409, 'conflict', `${base} is already here.`);
    }
  }
  const copied: string[] = [];
  for (const rel of rels) {
    const item = await locate(root, rel, 'read');
    if (item.outside || !item.exists) {
      throw new ApiError(403, 'outside_root', 'This link points outside the folder Larder is allowed to use.');
    }
    const source = item.isLink ? item.abs : requireInside(item);
    if (samePlace && (isWithin(source, destDir) || (item.real && isWithin(item.real, destDir)))) {
      throw new ApiError(400, 'invalid_name', 'A folder cannot be copied into itself.');
    }
    const base = path.basename(item.abs);
    let chosen = base;
    const existing = await namesIn(destDir);
    if (existing.has(base)) {
      if (onConflict === 'replace') {
        await removeTree(path.join(destDir, base), destJail);
      } else if (onConflict === 'keep') {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        let i = 1;
        while (existing.has(`${stem} (${i})${ext}`)) i += 1;
        chosen = `${stem} (${i})${ext}`;
      } else {
        throw new ApiError(409, 'conflict', `${base} is already here.`);
      }
    }
    const finalAbs = path.join(destDir, chosen);
    if (!isInside(destJail, finalAbs)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
    await copyNode(source, finalAbs, sourceJail, new Set());
    copied.push(safeSegments(toRel).concat(chosen).join('/').replace(/^\//, ''));
  }
  return copied.map((item) => item.replace(/^\//, ''));
}

export async function moveEntries(root: string, rels: string[], toRel: string, destRoot?: string): Promise<string[]> {
  const sourceJail = await rootReal(root);
  const destJail = await rootReal(destRoot ?? root);
  const samePlace = sourceJail === destJail;
  const destDirLocated = await locate(destRoot ?? root, toRel, 'read');
  const destDir = requireInside(destDirLocated);
  if (!destDirLocated.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const moved: string[] = [];
  for (const rel of rels) {
    const item = await locate(root, rel, 'read');
    if (!item.exists) throw new ApiError(404, 'not_found', 'That file is not there.');
    if (samePlace && path.dirname(item.abs) === destDir) throw new ApiError(400, 'invalid_name', 'That file is already in this folder.');
    if (samePlace && item.real && isWithin(item.real, destDir)) throw new ApiError(400, 'invalid_name', 'A folder cannot be moved into itself.');
    const base = path.basename(item.abs);
    if ((await namesIn(destDir)).has(base)) throw new ApiError(409, 'conflict', `${base} is already here.`);
    const dest = path.join(destDir, base);
    if (!isInside(destJail, dest)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
    await relocate(item.abs, dest, sourceJail);
    const prefix = safeSegments(toRel).join('/');
    moved.push(prefix ? `${prefix}/${base}` : base);
  }
  return moved;
}

async function relocate(src: string, dest: string, sourceJail: string) {
  try {
    await fs.rename(src, dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
    await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    await removeTree(src, sourceJail);
  }
}

export async function readBytes(root: string, rel: string): Promise<{ abs: string; name: string }> {
  const item = await locate(root, rel, 'read');
  const abs = requireInside(item);
  if (item.isDir) throw new ApiError(400, 'invalid_name', 'That path is a folder.');
  return { abs, name: path.basename(item.abs) };
}

export async function saveText(root: string, rel: string, text: string, mtime: number) {
  if (Buffer.byteLength(text) > 256 * 1024) throw new ApiError(413, 'too_large', 'This file is too large to edit here.');
  const item = await locate(root, rel, 'read');
  const abs = requireInside(item);
  if (item.isDir) throw new ApiError(400, 'invalid_name', 'That path is a folder.');
  const st = await fs.stat(abs);
  if (Math.abs(st.mtimeMs - mtime) > 1500) {
    throw new ApiError(409, 'conflict', 'This file changed on disk. Reload it, then save again.');
  }
  const tmp = path.join(path.dirname(abs), `.larder-upload-${cryptoRandom()}`);
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, abs);
}

function cryptoRandom(): string {
  return crypto.randomBytes(12).toString('hex');
}

export async function followFile(root: string, rel: string, offset: number) {
  const { abs } = await readBytes(root, rel);
  const st = await fs.stat(abs);
  const size = st.size;
  let start = offset;
  let reset = false;
  if (!Number.isFinite(start) || start < 0 || start > size) {
    start = Math.max(0, size - 1024 * 1024);
    reset = offset >= 0;
  }
  if (size - start > 1024 * 1024) start = size - 1024 * 1024;
  const handle = await fs.open(abs, 'r');
  try {
    const length = size - start;
    const buf = Buffer.alloc(length);
    if (length > 0) await handle.read(buf, 0, length, start);
    return { text: buf.toString('utf8'), size, offset: start, reset };
  } finally {
    await handle.close();
  }
}

export async function folderSize(root: string, rel: string): Promise<{ bytes: number; files: number }> {
  const item = await locate(root, rel, 'read');
  const abs = requireInside(item);
  if (!item.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const jail = await rootReal(root);
  let bytes = 0;
  let files = 0;
  async function walk(dir: string) {
    for (const name of await fs.readdir(dir)) {
      if (name === '.larder-trash' || name.startsWith('.larder-upload-')) continue;
      const child = path.join(dir, name);
      const st = await fs.lstat(child);
      if (st.isSymbolicLink()) continue;
      const real = await fs.realpath(child);
      if (!isInside(jail, real)) continue;
      if (st.isDirectory()) await walk(child);
      else {
        bytes += st.size;
        files += 1;
      }
    }
  }
  await walk(abs);
  return { bytes, files };
}

export async function searchNames(
  root: string,
  rel: string,
  query: string,
  includeHidden: boolean,
  filter: { type?: string; minSize?: number; maxSize?: number; after?: number; before?: number } = {},
) {
  const needle = query.trim().toLocaleLowerCase();
  const typed = Boolean(filter.type || filter.minSize != null || filter.maxSize != null || filter.after != null || filter.before != null);
  if (!needle && !typed) throw new ApiError(400, 'invalid_name', 'Type a name to search for.');
  const item = await locate(root, rel, 'read');
  const abs = requireInside(item);
  if (!item.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const jail = await rootReal(root);
  const base = safeSegments(rel);
  const results: { path: string; kind: Entry['kind']; symlinkTo?: 'file' | 'dir'; outside?: boolean; size: number | null; mtime: number | null }[] = [];
  const wanted = filter.type;
  function typeOk(name: string, kind: string): boolean {
    if (!wanted || wanted === 'any') return true;
    if (wanted === 'folder') return kind === 'dir';
    if (kind === 'dir') return false;
    const ext = path.extname(name).toLowerCase();
    const groups: Record<string, string[]> = {
      image: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
      video: ['.mp4', '.webm', '.ogv', '.mov', '.mkv'],
      audio: ['.mp3', '.wav', '.ogg', '.flac', '.m4a'],
      text: ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.csv', '.log', '.html', '.htm'],
      archive: ['.zip'],
    };
    return (groups[wanted] ?? []).includes(ext);
  }
  function rangeOk(size: number | null, mtime: number | null, kind: string): boolean {
    if (kind !== 'dir') {
      if (filter.minSize != null && (size ?? 0) < filter.minSize) return false;
      if (filter.maxSize != null && (size ?? 0) > filter.maxSize) return false;
    } else if (filter.minSize != null || filter.maxSize != null) return false;
    if (filter.after != null && (mtime ?? 0) < filter.after) return false;
    if (filter.before != null && (mtime ?? 0) > filter.before) return false;
    return true;
  }
  async function walk(dir: string, prefix: string[]) {
    if (results.length >= 500) return;
    for (const name of await fs.readdir(dir)) {
      if (results.length >= 500) return;
      if (name === '.larder-trash' || name.startsWith('.larder-upload-')) continue;
      if (!includeHidden && name.startsWith('.')) continue;
      const child = path.join(dir, name);
      const relPath = [...prefix, name].join('/');
      let st: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        st = await fs.lstat(child);
      } catch {
        continue;
      }
      const matched = name.toLocaleLowerCase().includes(needle);
      if (st.isSymbolicLink()) {
        if (matched && typeOk(name, 'file') && rangeOk(st.size, st.mtimeMs, 'file')) {
          let outside = true;
          let symlinkTo: 'file' | 'dir' | undefined;
          try {
            const real = await fs.realpath(child);
            outside = !isInside(jail, real);
            if (!outside) symlinkTo = (await fs.stat(real)).isDirectory() ? 'dir' : 'file';
          } catch {
            outside = true;
          }
          results.push({ path: relPath, kind: 'symlink', symlinkTo, outside, size: st.size, mtime: st.mtimeMs });
        }
        continue;
      }
      const kind = st.isDirectory() ? 'dir' : 'file';
      if ((matched || (!needle && typed)) && typeOk(name, kind) && rangeOk(kind === 'dir' ? null : st.size, st.mtimeMs, kind)) {
        results.push({ path: relPath, kind, size: kind === 'dir' ? null : st.size, mtime: st.mtimeMs });
      }
      if (st.isDirectory()) await walk(child, [...prefix, name]);
    }
  }
  await walk(abs, base);
  return results;
}

async function trashRoot(root: string): Promise<string> {
  const jail = await rootReal(root);
  const dir = path.join(jail, '.larder-trash');
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink()) throw new ApiError(400, 'outside_root', 'Trash is not available in this folder.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') await fs.mkdir(dir);
    else throw error;
  }
  const real = await fs.realpath(dir);
  if (!isInside(jail, real)) throw new ApiError(400, 'outside_root', 'Trash is not available in this folder.');
  return real;
}

export async function moveToTrash(root: string, rels: string[], username: string) {
  const trash = await trashRoot(root);
  const trashed: string[] = [];
  for (const rel of rels) {
    const item = await locate(root, rel, 'read');
    if (!item.exists) throw new ApiError(404, 'not_found', 'That file is not there.');
    const id = cryptoRandom();
    const dest = path.join(trash, id);
    await fs.rename(item.abs, dest);
    const record = {
      id,
      name: path.basename(item.abs),
      originalPath: safeSegments(rel).join('/'),
      deletedBy: username,
      deletedAt: new Date().toISOString(),
      kind: item.isLink ? 'symlink' : item.isDir ? 'dir' : 'file',
    };
    await fs.writeFile(path.join(trash, `${id}.json`), JSON.stringify(record), 'utf8');
    trashed.push(record.originalPath);
  }
  return trashed;
}

export type TrashItem = {
  id: string;
  name: string;
  originalPath: string;
  deletedBy: string;
  deletedAt: string;
  kind: string;
};

export async function purgeExpiredTrash() {
  const days = runtime().config.trashDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rt = runtime();
  const folders = rt.config.roots.map((root) => resolveConfigPath(rt.configPath, root.path));
  if (rt.config.homes.enabled && rt.config.homes.path) {
    const homes = resolveConfigPath(rt.configPath, rt.config.homes.path);
    for (const user of rt.config.users) {
      if (user.home) folders.push(path.join(homes, user.username));
    }
  }
  for (const folder of folders) {
    await purgeTrashFolder(folder, cutoff).catch(() => undefined);
  }
}

async function purgeTrashFolder(rootAbs: string, cutoff: number) {
  let trash: string;
  try {
    trash = await trashRoot(rootAbs);
  } catch {
    return;
  }
  const jail = await rootReal(rootAbs);
  for (const name of await fs.readdir(trash)) {
    if (!name.endsWith('.json')) continue;
    const metaPath = path.join(trash, name);
    let record: TrashItem;
    try {
      record = JSON.parse(await fs.readFile(metaPath, 'utf8')) as TrashItem;
    } catch {
      continue;
    }
    const when = Date.parse(record.deletedAt);
    if (!Number.isFinite(when) || when > cutoff) continue;
    await removeTree(path.join(trash, name.slice(0, -'.json'.length)), jail).catch(() => undefined);
    await fs.unlink(metaPath).catch(() => undefined);
  }
}

export async function listTrash(root: string): Promise<TrashItem[]> {
  const trash = await trashRoot(root);
  const names = await fs.readdir(trash);
  const items: TrashItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      items.push(JSON.parse(await fs.readFile(path.join(trash, name), 'utf8')) as TrashItem);
    } catch {
      /* skip */
    }
  }
  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return items;
}

export async function restoreTrash(root: string, id: string, onConflict?: 'replace' | 'keep') {
  if (!/^[a-z0-9]+$/i.test(id)) throw new ApiError(400, 'invalid_name', 'That trash item is not valid.');
  const trash = await trashRoot(root);
  const metaPath = path.join(trash, `${id}.json`);
  const itemPath = path.join(trash, id);
  const record = JSON.parse(await fs.readFile(metaPath, 'utf8')) as TrashItem;
  const segments = safeSegments(record.originalPath);
  const jail = await rootReal(root);
  const parentRel = segments.slice(0, -1).join('/');
  const parent = await locate(root, parentRel, 'read');
  const dir = requireInside(parent);
  const base = segments.at(-1)!;
  let chosen = base;
  if ((await namesIn(dir)).has(base)) {
    if (onConflict === 'replace') await removeTree(path.join(dir, base), jail);
    else if (onConflict === 'keep') {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      const existing = await namesIn(dir);
      let i = 1;
      while (existing.has(`${stem} (${i})${ext}`)) i += 1;
      chosen = `${stem} (${i})${ext}`;
    } else throw new ApiError(409, 'conflict', `${base} is already here.`);
  }
  await fs.rename(itemPath, path.join(dir, chosen));
  await fs.unlink(metaPath);
  const prefix = segments.slice(0, -1).join('/');
  return prefix ? `${prefix}/${chosen}` : chosen;
}

export async function emptyTrash(root: string) {
  const trash = await trashRoot(root);
  const jail = await rootReal(root);
  for (const name of await fs.readdir(trash)) {
    await removeTree(path.join(trash, name), jail);
  }
}

export async function collectForZip(root: string, rels: string[], limit = Number.POSITIVE_INFINITY): Promise<{ abs: string; name: string }[]> {
  const jail = await rootReal(root);
  const out: { abs: string; name: string }[] = [];
  const seen = new Set<string>();
  async function walk(abs: string, zipName: string, isDir: boolean) {
    if (out.length >= limit) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    if (!isDir) {
      out.push({ abs, name: zipName });
      return;
    }
    for (const name of await fs.readdir(abs)) {
      if (out.length >= limit) return;
      if (name === '.larder-trash' || name.startsWith('.larder-upload-')) continue;
      const child = path.join(abs, name);
      const st = await fs.lstat(child);
      const entryName = `${zipName}/${name}`;
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = await fs.realpath(child);
        } catch {
          continue;
        }
        if (!isInside(jail, real) || seen.has(real)) continue;
        const followed = await fs.stat(real);
        await walk(real, entryName, followed.isDirectory());
        continue;
      }
      if (!isInside(jail, child)) continue;
      await walk(child, entryName, st.isDirectory());
    }
  }
  for (const rel of rels) {
    const item = await locate(root, rel, 'read');
    if (!item.exists || item.outside || !item.real) {
      throw new ApiError(403, 'outside_root', 'This link points outside the folder Larder is allowed to use.');
    }
    await walk(item.real, path.basename(item.abs), item.isDir);
  }
  return out;
}
