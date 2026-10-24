import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { ApiError } from './errors.js';
import { collectForZip, locate, placeName, removeTree, rootReal } from './files.js';
import { isInside, safeZipEntryName } from './paths.js';

export function zipStream(files: { abs: string; name: string }[]): ZipArchive {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  for (const file of files) archive.file(file.abs, { name: file.name });
  void archive.finalize();
  return archive;
}

function writeZip(files: { abs: string; name: string }[], dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const fail = (error: unknown) => {
      out.destroy();
      reject(error instanceof Error ? error : new Error('The zip could not be written.'));
    };
    archive.on('error', fail);
    out.on('error', fail);
    out.on('close', () => resolve());
    archive.pipe(out);
    for (const file of files) archive.file(file.abs, { name: file.name });
    void archive.finalize();
  });
}

export async function saveZip(rootAbs: string, rels: string[], maxBytes: number): Promise<string> {
  if (rels.length === 0) throw new ApiError(400, 'invalid_name', 'Choose something to zip.');
  const files = await collectForZip(rootAbs, rels);
  let bytes = 0;
  for (const file of files) {
    bytes += (await fsp.stat(file.abs)).size;
    if (bytes > maxBytes) throw new ApiError(413, 'too_large', 'That folder is over the upload limit.');
  }
  const first = rels[0] ?? '';
  const parentRel = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
  const parent = await locate(rootAbs, parentRel, 'read');
  if (!parent.real || parent.outside || !parent.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
  const stem = rels.length === 1 ? path.basename(first).replace(/\.zip$/i, '') || 'archive' : 'archive';
  const chosen = await placeName(parent.real, `${stem}.zip`, 'keep');
  const finalAbs = path.join(parent.real, chosen);
  const jail = await rootReal(rootAbs);
  if (!isInside(jail, finalAbs)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
  const temp = path.join(parent.real, `.larder-upload-${crypto.randomBytes(8).toString('hex')}`);
  try {
    await writeZip(files, temp);
    await fsp.rename(temp, finalAbs);
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }
  return parentRel ? `${parentRel}/${chosen}` : chosen;
}

export async function listZipEntries(file: string, limit: number): Promise<{ entries: { name: string; size: number }[]; more: boolean }> {
  const zip = await openZip(file);
  const entries: { name: string; size: number }[] = [];
  let more = false;
  let seen = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      if (error) reject(error instanceof Error ? error : new Error('That zip could not be previewed.'));
      else resolve();
    };
    zip.on('error', (error) => finish(error));
    zip.on('end', () => finish());
    zip.on('entry', (entry: yauzl.Entry) => {
      seen += 1;
      if (seen > 5000 || entries.length >= limit) {
        more = true;
        finish();
        return;
      }
      if (!entry.fileName.endsWith('/') && !entry.fileName.endsWith('\\')) {
        const safe = safeZipEntryName(entry.fileName);
        if (safe) entries.push({ name: safe, size: entry.uncompressedSize });
      }
      zip.readEntry();
    });
    zip.readEntry();
  });
  return { entries, more };
}

export type ZipEntryRead = { bytes: Buffer; truncated: boolean } | { tooBig: true };

export function readZipEntry(file: string, entryName: string, maxBytes: number, truncate: boolean): Promise<ZipEntryRead | null> {
  const wanted = safeZipEntryName(entryName);
  if (!wanted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('That zip could not be previewed.'));
        return;
      }
      let settled = false;
      const finish = (failure: unknown, value: ZipEntryRead | null) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (failure) reject(failure instanceof Error ? failure : new Error('That zip could not be previewed.'));
        else resolve(value);
      };
      zip.on('error', (failure) => finish(failure, null));
      zip.on('end', () => finish(null, null));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/') || entry.fileName.endsWith('\\') || safeZipEntryName(entry.fileName) !== wanted) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > maxBytes && !truncate) {
          finish(null, { tooBig: true });
          return;
        }
        zip.openReadStream(entry, (failure, stream) => {
          if (failure || !stream) {
            finish(failure ?? new Error('That zip could not be previewed.'), null);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          const stop = () => {
            finish(null, truncated && !truncate ? { tooBig: true } : { bytes: Buffer.concat(chunks), truncated });
            stream.destroy();
          };
          stream.on('data', (chunk: Buffer) => {
            if (settled) return;
            const buf = Buffer.from(chunk);
            const room = maxBytes - total;
            if (buf.length > room) {
              if (truncate && room > 0) chunks.push(buf.subarray(0, room));
              total = maxBytes;
              truncated = true;
              stop();
              return;
            }
            chunks.push(buf);
            total += buf.length;
          });
          stream.on('end', () => {
            if (!settled) finish(null, { bytes: Buffer.concat(chunks), truncated });
          });
          stream.on('error', (failure) => finish(failure, null));
        });
      });
      zip.readEntry();
    });
  });
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('zip'));
      else resolve(zip);
    });
  });
}

export async function extractZip(rootAbs: string, rel: string, maxBytes: number): Promise<string> {
  const item = await locate(rootAbs, rel, 'read');
  if (!item.exists || item.outside || !item.real || item.isDir) {
    throw new ApiError(400, 'invalid_name', 'Choose a zip file.');
  }
  const jail = await rootReal(rootAbs);
  const parent = path.dirname(item.real);
  const stem = path.basename(item.abs, path.extname(item.abs)) || 'archive';
  const existing = new Set(await fsp.readdir(parent));
  let folder = stem;
  if (existing.has(folder)) {
    let i = 1;
    while (existing.has(`${stem} (${i})`)) i += 1;
    folder = `${stem} (${i})`;
  }
  const dest = path.join(parent, folder);
  if (!isInside(jail, dest)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
  await fsp.mkdir(dest);
  const zip = await openZip(item.real);
  let entries = 0;
  let written = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        zip.close();
        reject(error instanceof ApiError ? error : new ApiError(400, 'invalid_name', 'That zip could not be extracted.'));
      };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        entries += 1;
        if (entries > 10_000) {
          fail(new ApiError(413, 'too_large', 'That zip has too many files.'));
          return;
        }
        const safe = safeZipEntryName(entry.fileName);
        if (!safe) {
          fail(new ApiError(400, 'outside_root', 'That zip tries to leave this folder.'));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          fsp
            .mkdir(path.join(dest, safe), { recursive: true })
            .then(() => zip.readEntry())
            .catch(fail);
          return;
        }
        written += entry.uncompressedSize;
        if (written > maxBytes) {
          fail(new ApiError(413, 'too_large', 'That zip is over the upload limit when extracted.'));
          return;
        }
        const target = path.join(dest, safe);
        if (!isInside(dest, target)) {
          fail(new ApiError(400, 'outside_root', 'That zip tries to leave this folder.'));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error ?? new Error('zip stream'));
            return;
          }
          fsp
            .mkdir(path.dirname(target), { recursive: true })
            .then(
              () =>
                new Promise<void>((done, rejectStream) => {
                  let bytes = 0;
                  const out = fs.createWriteStream(target);
                  stream.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > maxBytes) stream.destroy(new Error('too_large'));
                  });
                  stream.pipe(out);
                  out.on('finish', () => done());
                  out.on('error', rejectStream);
                  stream.on('error', rejectStream);
                }),
            )
            .then(() => zip.readEntry())
            .catch(fail);
        });
      });
      zip.on('end', () => resolve());
      zip.readEntry();
    });
  } catch (error) {
    await removeTree(dest, jail).catch(() => undefined);
    throw error;
  }
  const parentRel = safeParent(rel);
  return parentRel ? `${parentRel}/${folder}` : folder;
}

function safeParent(rel: string): string {
  const parts = rel.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}
