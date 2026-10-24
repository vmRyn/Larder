export type Access = 'view' | 'edit';

export type RootInfo = {
  id: string;
  name: string;
  access: Access;
  freeBytes: number | null;
  totalBytes: number | null;
};

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

export type Session =
  | { state: 'setup' }
  | { state: 'login' }
  | {
      state: 'ready';
      user: { username: string; displayName: string; admin: boolean };
      roots: RootInfo[];
      homesEnabled: boolean;
      warnings: { id: string; name: string; path: string }[];
    };

export type Favorite = { root: string; path: string };

export type TrashItem = {
  id: string;
  name: string;
  originalPath: string;
  deletedBy: string;
  deletedAt: string;
  kind: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-Larder-Request', '1');
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { error?: string; code?: string; retryAfterMs?: number }) : ({} as T);
  if (!response.ok) {
    const body = data as { error?: string; code?: string; retryAfterMs?: number };
    throw new ApiError(body.error ?? 'Something went wrong.', body.code ?? 'error', response.status, body.retryAfterMs ?? 0);
  }
  return data;
}

export function session() {
  return api<Session>('/api/session');
}
