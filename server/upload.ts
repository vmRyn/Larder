import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import Busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';
import { scanFile } from './scan.js';
import { locate, placeName, rootReal } from './files.js';
import { isInside, nameError, safeSegments } from './paths.js';

export async function sha256File(abs: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function makeThumb(abs: string, cacheDir: string, key: string): Promise<string> {
  const dest = path.join(cacheDir, `${key}.jpg`);
  try {
    await fsp.access(dest);
    return dest;
  } catch {
    /* create it */
  }
  const sharp = (await import('sharp')).default;
  await fsp.mkdir(cacheDir, { recursive: true });
  await sharp(abs, { animated: false, limitInputPixels: 40_000_000 })
    .rotate()
    .resize(160, 160, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toFile(dest);
  return dest;
}

const exec = promisify(execFile);
const VIDEO = new Set(['.mp4', '.webm', '.ogv', '.mov', '.mkv']);

export function isVideoFile(name: string): boolean {
  return VIDEO.has(path.extname(name).toLowerCase());
}

const HEIC = new Set(['.heic', '.heif']);

export function isHeicFile(name: string): boolean {
  return HEIC.has(path.extname(name).toLowerCase());
}

export async function heicJpeg(abs: string, cacheDir: string, key: string): Promise<string> {
  const dest = path.join(cacheDir, `${key}.heic.jpg`);
  try {
    await fsp.access(dest);
    return dest;
  } catch {
    /* create it */
  }
  const sharp = (await import('sharp')).default;
  await fsp.mkdir(cacheDir, { recursive: true });
  try {
    await sharp(abs, { limitInputPixels: 40_000_000, failOn: 'none' })
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(dest);
  } catch {
    await fsp.unlink(dest).catch(() => undefined);
    throw new ApiError(404, 'not_found', 'This photo cannot be previewed on this server.');
  }
  return dest;
}

let ffprobe: Promise<boolean> | null = null;

function hasFfprobe(): Promise<boolean> {
  ffprobe ??= exec('ffprobe', ['-version'], { timeout: 4000, windowsHide: true }).then(
    () => true,
    () => false,
  );
  return ffprobe;
}

export async function mediaDuration(abs: string, cacheDir: string, key: string): Promise<number | null> {
  if (!(await hasFfprobe())) return null;
  const dest = path.join(cacheDir, `${key}.duration`);
  try {
    const cached = Number(await fsp.readFile(dest, 'utf8'));
    if (Number.isFinite(cached) && cached >= 0) return cached;
  } catch {
    /* measure it */
  }
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { timeout: 8000, windowsHide: true });
    const seconds = Number(String(stdout).trim());
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(dest, String(seconds));
    return seconds;
  } catch {
    return null;
  }
}

export async function makeVideoThumb(abs: string, cacheDir: string, key: string): Promise<string> {
  const dest = path.join(cacheDir, `${key}.jpg`);
  try {
    await fsp.access(dest);
    return dest;
  } catch {
    /* create it */
  }
  await fsp.mkdir(cacheDir, { recursive: true });
  await exec(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '00:00:01', '-i', abs, '-frames:v', '1', '-vf', 'scale=160:160:force_original_aspect_ratio=decrease', dest],
    { timeout: 20_000, windowsHide: true },
  );
  await fsp.access(dest);
  return dest;
}

export async function ensureFolder(rootAbs: string, rel: string) {
  const segments = safeSegments(rel);
  let current = '';
  for (const segment of segments) {
    const next = current ? `${current}/${segment}` : segment;
    try {
      const found = await locate(rootAbs, next, 'read');
      if (!found.isDir) throw new ApiError(409, 'conflict', `${segment} is already here as a file.`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'not_found') throw error;
      const parent = await locate(rootAbs, current, 'read');
      if (!parent.isDir || !parent.real) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
      const problem = nameError(segment);
      if (problem) throw new ApiError(400, 'invalid_name', problem);
      await fsp.mkdir(path.join(parent.real, segment));
    }
    current = next;
  }
}

function drain(stream: NodeJS.ReadableStream) {
  return new Promise<void>((resolve, reject) => {
    stream.on('data', () => undefined);
    stream.on('end', () => resolve());
    stream.on('error', reject);
    stream.resume();
  });
}

export function receiveUpload(
  incoming: IncomingMessage,
  rootAbs: string,
  destRel: string,
  onConflict: 'replace' | 'keep' | undefined,
  maxBytes: number,
): Promise<{ saved: string[]; conflicts: string[] }> {
  const saved: string[] = [];
  const conflicts: string[] = [];
  const temps: string[] = [];
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: incoming.headers, defParamCharset: 'utf8', limits: { files: 5000, fileSize: maxBytes } });
    let chain = Promise.resolve();
    let failed: ApiError | null = null;
    const cleanup = () => Promise.all(temps.map((file) => fsp.unlink(file).catch(() => undefined)));

    bb.on('file', (_field, stream, info) => {
      stream.pause();
      chain = chain.then(async () => {
        if (failed) {
          await drain(stream);
          return;
        }
        try {
          const relName = (info.filename ?? 'file').replace(/\\/g, '/');
          const segments = safeSegments(relName);
          if (segments.length === 0) {
            await drain(stream);
            return;
          }
          const parentRel = [...safeSegments(destRel), ...segments.slice(0, -1)].join('/');
          await ensureFolder(rootAbs, parentRel);
          const parent = await locate(rootAbs, parentRel, 'read');
          if (!parent.real || !parent.isDir) throw new ApiError(400, 'invalid_name', 'That path is not a folder.');
          const leaf = segments.at(-1)!;
          let chosen: string;
          try {
            chosen = await placeName(parent.real, leaf, onConflict);
          } catch (error) {
            if (error instanceof ApiError && error.code === 'conflict' && !onConflict) {
              conflicts.push([...safeSegments(destRel), ...segments].filter(Boolean).join('/'));
              await drain(stream);
              return;
            }
            throw error;
          }
          if (onConflict === 'replace') {
            const existing = path.join(parent.real, chosen);
            const st = await fsp.lstat(existing).catch(() => null);
            if (st?.isDirectory()) throw new ApiError(409, 'conflict', `${chosen} is a folder.`);
          }
          const temp = path.join(parent.real, `.larder-upload-${crypto.randomBytes(8).toString('hex')}`);
          temps.push(temp);
          await new Promise<void>((done, fail) => {
            const out = fs.createWriteStream(temp);
            stream.resume();
            stream.pipe(out);
            out.on('finish', () => done());
            out.on('error', fail);
            stream.on('error', fail);
          });
          if ((stream as NodeJS.ReadableStream & { truncated?: boolean }).truncated) {
            throw new ApiError(413, 'too_large', 'That file is over the upload limit.');
          }
          const finalAbs = path.join(parent.real, chosen);
          if (!isInside(await rootReal(rootAbs), finalAbs)) throw new ApiError(400, 'outside_root', 'That path is outside this folder.');
          await scanFile(temp);
          await fsp.rename(temp, finalAbs);
          temps.splice(temps.indexOf(temp), 1);
          const prefix = safeSegments(destRel).concat(segments.slice(0, -1), chosen);
          saved.push(prefix.join('/'));
        } catch (error) {
          failed = error instanceof ApiError ? error : new ApiError(500, 'error', 'The upload failed.');
          stream.resume();
          await drain(stream).catch(() => undefined);
        }
      });
    });
    bb.on('error', (error) => {
      failed = error instanceof ApiError ? error : new ApiError(400, 'invalid_name', 'The upload could not be read.');
    });
    bb.on('finish', () => {
      chain
        .then(async () => {
          await cleanup();
          if (failed) reject(failed);
          else resolve({ saved, conflicts });
        })
        .catch((error) => reject(error));
    });
    incoming.on('aborted', () => {
      void cleanup();
    });
    incoming.pipe(bb);
  });
}
