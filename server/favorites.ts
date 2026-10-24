import fs from 'node:fs/promises';
import path from 'node:path';
import { runtime } from './config.js';

export type Favorite = { root: string; path: string };

type Store = Record<string, Favorite[]>;

let lock: Promise<void> = Promise.resolve();

async function file(): Promise<string> {
  return path.join(runtime().dataDir, 'favorites.json');
}

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(await file(), 'utf8')) as Store;
  } catch {
    return {};
  }
}

export async function favoritesFor(username: string): Promise<Favorite[]> {
  const store = await readStore();
  return store[username] ?? [];
}

export function setFavorite(username: string, favorite: Favorite, pinned: boolean): Promise<void> {
  const run = lock.then(async () => {
    const store = await readStore();
    const list = store[username] ?? [];
    const next = list.filter((item) => !(item.root === favorite.root && item.path === favorite.path));
    if (pinned) next.unshift(favorite);
    store[username] = next.slice(0, 100);
    const tmp = `${await file()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(tmp, await file());
  });
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
