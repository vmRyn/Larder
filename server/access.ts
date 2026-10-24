import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfigPath, runtime, type Access, type ConfigUser } from './config.js';
import { ApiError } from './errors.js';

const rank: Record<Access, number> = { view: 1, edit: 2 };

export function vaultName(username: string): string {
  const name = username.trim();
  const label = name ? name.charAt(0).toUpperCase() + name.slice(1) : 'User';
  return `${label}s Vault`;
}

export function grantFor(user: ConfigUser, rootId: string): Access | undefined {
  if (user.admin) return 'edit';
  let best = user.grants[rootId];
  for (const id of user.groups ?? []) {
    const grant = runtime().config.groups?.find((group) => group.id === id)?.grants[rootId];
    if (!grant) continue;
    if (!best || rank[grant] > rank[best]) best = grant;
  }
  return best;
}

export type VisibleRoot = {
  id: string;
  name: string;
  access: Access;
  abs: string;
  freeBytes: number | null;
  totalBytes: number | null;
};

export type RootWarning = { id: string; name: string; path: string };

async function space(abs: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  try {
    const stats = await fs.statfs(abs);
    const block = Number(stats.bsize);
    return { freeBytes: Number(stats.bavail) * block, totalBytes: Number(stats.blocks) * block };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

async function usableDir(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function visibleRoots(user: ConfigUser): Promise<{ roots: VisibleRoot[]; warnings: RootWarning[] }> {
  const rt = runtime();
  const roots: VisibleRoot[] = [];
  const warnings: RootWarning[] = [];
  for (const root of rt.config.roots) {
    const access = grantFor(user, root.id);
    if (!access) continue;
    const abs = resolveConfigPath(rt.configPath, root.path);
    if (!(await usableDir(abs))) {
      if (user.admin) warnings.push({ id: root.id, name: root.name, path: abs });
      continue;
    }
    roots.push({ id: root.id, name: root.name, access, abs, ...(await space(abs)) });
  }
  if (rt.config.homes.enabled && rt.config.homes.path) {
    const homesAbs = resolveConfigPath(rt.configPath, rt.config.homes.path);
    if (await usableDir(homesAbs)) {
      const people = rt.config.users.filter((item) => item.home && (user.admin || item.username === user.username));
      for (const person of people) {
        const abs = path.join(homesAbs, person.username);
        await fs.mkdir(abs, { recursive: true });
        roots.unshift({
          id: `home:${person.username}`,
          name: vaultName(person.username),
          access: 'edit',
          abs,
          ...(await space(abs)),
        });
      }
    } else if (user.admin) {
      warnings.push({ id: 'homes', name: 'Vaults', path: homesAbs });
    }
  }
  return { roots, warnings: user.admin ? warnings : [] };
}

export async function requireRoot(user: ConfigUser, id: string, need: Access): Promise<VisibleRoot> {
  const { roots } = await visibleRoots(user);
  const root = roots.find((item) => item.id === id);
  if (!root) throw new ApiError(404, 'not_found', 'That folder is not available.');
  if (need === 'edit' && root.access !== 'edit') {
    throw new ApiError(403, 'forbidden', 'You can look at this folder, not change it.');
  }
  return root;
}
