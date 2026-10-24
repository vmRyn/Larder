import path from 'node:path';
import { ApiError } from './errors.js';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isReservedName(name: string): boolean {
  return process.platform === 'win32' && RESERVED.test(name);
}

export function nameError(name: string): string | null {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return 'Use a name without slashes.';
  }
  if (name === '.larder-trash' || name.startsWith('.larder-upload-')) {
    return 'That name is reserved.';
  }
  if (isReservedName(name)) return 'That name is reserved on Windows.';
  return null;
}

/** Relative API paths use `/` and never leave the root by syntax alone. */
export function safeSegments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\')) {
    throw new ApiError(400, 'invalid_name', 'That path is not allowed.');
  }
  let value = rel.trim();
  if (value.startsWith('/')) throw new ApiError(400, 'invalid_name', 'That path is not allowed.');
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (value === '' || value === '.') return [];
  const parts = value.split('/');
  for (const part of parts) {
    const problem = nameError(part);
    if (problem || part === '.' || part === '..') {
      throw new ApiError(400, 'invalid_name', problem ?? 'That path is not allowed.');
    }
  }
  return parts;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Zip entry names that would escape the destination folder are rejected. */
export function safeZipEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  if (parts.some((part) => nameError(part))) return null;
  return parts.join('/');
}

export function formatMode(mode: number): string {
  const bits = mode & 0o777;
  const rwx = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return rwx(bits >> 6) + rwx(bits >> 3) + rwx(bits);
}

export function uniqueName(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ApiError(409, 'conflict', 'Too many files share that name.');
}
