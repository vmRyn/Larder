import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const TEXT = new Set(['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.xml', '.yml', '.yaml', '.ini', '.conf', '.log', '.sh', '.py', '.go', '.rs', '.toml', '.csv', '.env', '.c', '.cpp', '.h', '.html', '.htm']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif']);
const VIDEO = new Set(['.mp4', '.webm', '.ogv']);
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

export function isAudioFile(name: string): boolean {
  return AUDIO.has(path.extname(name).toLowerCase());
}
const TEXT_PREVIEW_BYTES = 1024 * 1024;

export type PreviewKind = 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'zip' | 'none';

export function isTextFile(name: string): boolean {
  return TEXT.has(path.extname(name).toLowerCase());
}

export function isImageFile(name: string): boolean {
  return IMAGE.has(path.extname(name).toLowerCase());
}

export function canPreview(name: string): boolean {
  const kind = previewKind(name);
  return kind === 'text' || kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio';
}

export function previewKind(name: string): PreviewKind {
  const ext = path.extname(name).toLowerCase();
  if (TEXT.has(ext)) return 'text';
  if (IMAGE.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (ext === '.zip') return 'zip';
  return 'none';
}

export async function readPreviewText(abs: string): Promise<{ text: string; truncated: boolean }> {
  const st = await fsp.stat(abs);
  const length = Math.min(st.size, TEXT_PREVIEW_BYTES);
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(length);
    if (length > 0) await fh.read(buf, 0, length, 0);
    return { text: buf.toString('utf8'), truncated: st.size > TEXT_PREVIEW_BYTES };
  } finally {
    await fh.close();
  }
}

export function mediaType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
  };
  if (TEXT.has(ext)) return 'text/plain; charset=utf-8';
  return types[ext] ?? 'application/octet-stream';
}

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function fileResponse(abs: string, name: string, request: Request, inline: boolean): Promise<Response> {
  const st = await fsp.stat(abs);
  const headers = new Headers();
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', inline ? mediaType(name) : 'application/octet-stream');
  headers.set('Content-Disposition', disposition(inline ? 'inline' : 'attachment', name));
  headers.set('Cache-Control', 'private, no-store');
  const range = inline ? request.headers.get('range') : null;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers });
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : st.size - 1;
    if (start >= st.size || end >= st.size || start > end) {
      headers.set('Content-Range', `bytes */${st.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${st.size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers.set('Content-Length', String(st.size));
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as ReadableStream, { status: 200, headers });
}
