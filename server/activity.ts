import fs from 'node:fs/promises';
import path from 'node:path';
import { runtime } from './config.js';

export type ActivityRow = {
  t: string;
  user: string;
  action: string;
  root: string;
  path: string;
};

const ACTIVITY_CAP = 5000;

let lock: Promise<void> = Promise.resolve();

function withLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = lock;
  let release: () => void = () => undefined;
  lock = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(run, run).finally(release);
}

export async function logActivity(row: Omit<ActivityRow, 't'>) {
  await withLock(async () => {
    const file = activityFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ...row })}\n`, 'utf8');
    await trimActivity(await readActivityFile());
  });
}

export async function readActivity(offset = 0, limit = 100): Promise<{ entries: ActivityRow[]; total: number }> {
  const rows = await withLock(async () => trimActivity(await readActivityFile()));
  const newest = rows.slice().reverse();
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const size = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
  return { entries: newest.slice(start, start + size), total: newest.length };
}

export async function latestByUser(): Promise<Map<string, { t: string; action: string }>> {
  const latest = new Map<string, { t: string; action: string }>();
  for (const row of await readActivityFile()) {
    const previous = latest.get(row.user);
    if (!previous || row.t > previous.t) latest.set(row.user, { t: row.t, action: row.action });
  }
  return latest;
}

function activityFile() {
  return path.join(runtime().dataDir, 'activity.jsonl');
}

async function trimActivity(rows: ActivityRow[]): Promise<ActivityRow[]> {
  if (rows.length <= ACTIVITY_CAP) return rows;
  const kept = rows.slice(-ACTIVITY_CAP);
  const file = activityFile();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  await fs.rename(tmp, file);
  return kept;
}

async function readActivityFile(): Promise<ActivityRow[]> {
  const file = activityFile();
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows: ActivityRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ActivityRow);
    } catch {
      /* skip a torn line */
    }
  }
  return rows;
}
