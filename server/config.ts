import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';

export type Access = 'view' | 'edit';

export type ConfigGroup = {
  id: string;
  name: string;
  grants: Record<string, Access>;
};

export type ConfigUser = {
  username: string;
  displayName: string;
  passwordHash: string;
  admin: boolean;
  disabled: boolean;
  home: boolean;
  grants: Record<string, Access>;
  groups?: string[];
};

export type Config = {
  host: string;
  port: number;
  sessionSecret: string;
  maxUploadBytes: number;
  homes: { enabled: boolean; path: string };
  roots: { id: string; name: string; path: string }[];
  users: ConfigUser[];
  groups?: ConfigGroup[];
  trashDays?: number | null;
};

export type Runtime = {
  configPath: string;
  dataDir: string;
  config: Config;
};

let state: Runtime | null = null;
let lock: Promise<void> = Promise.resolve();

export function runtime(): Runtime {
  if (!state) throw new ApiError(500, 'not_configured', 'Larder is not ready.');
  return state;
}

export function resolveConfigPath(configFile: string, target: string): string {
  if (path.isAbsolute(target)) return path.normalize(target);
  return path.resolve(path.dirname(configFile), target);
}

export async function initRuntime(): Promise<Runtime> {
  const configPath = process.env.LARDER_CONFIG
    ? path.resolve(process.env.LARDER_CONFIG)
    : path.join(process.cwd(), 'larder.config.json');
  try {
    await fs.access(configPath);
  } catch {
    const example = path.join(process.cwd(), 'larder.config.example.json');
    await fs.copyFile(example, configPath);
  }
  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Config;
  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
    await writeConfig(configPath, config);
  }
  config.users ??= [];
  config.roots ??= [];
  config.homes ??= { enabled: false, path: '' };
  config.groups ??= [];
  for (const user of config.users) user.groups ??= [];
  config.maxUploadBytes ??= 8 * 1024 * 1024 * 1024;
  const dataDir = path.join(path.dirname(configPath), 'data');
  await fs.mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'thumbnails'), { recursive: true });
  state = { configPath, dataDir, config };
  return state;
}

export function updateConfig(fn: (config: Config) => void | Promise<void>): Promise<void> {
  const run = lock.then(async () => {
    const current = runtime();
    await fn(current.config);
    await writeConfig(current.configPath, current.config);
  });
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeConfig(configPath: string, config: Config) {
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, configPath);
}

export function findUser(username: string): ConfigUser | undefined {
  return runtime().config.users.find((user) => user.username === username);
}

export function publicUser(user: ConfigUser) {
  return {
    username: user.username,
    displayName: user.displayName,
    admin: user.admin,
    disabled: user.disabled,
    home: user.home,
    grants: user.grants,
    groups: user.groups ?? [],
  };
}

export function assertUsername(username: string) {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(username)) {
    throw new ApiError(400, 'invalid_name', 'Usernames are 3–32 characters: a letter, then letters, digits, or hyphens.');
  }
}

export function assertPassword(password: string) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new ApiError(400, 'invalid_name', 'Use at least 12 characters.');
  }
}

export function adminCount(users: ConfigUser[] = runtime().config.users): number {
  return users.filter((user) => user.admin && !user.disabled).length;
}
