import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

export type HostSample = {
  memory: { usedBytes: number; totalBytes: number };
  cpu: number | null;
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
};

type Counters = { at: number; idle: number; total: number; rx: number | null; tx: number | null };

let previous: Counters | null = null;
let tail: Promise<void> = Promise.resolve();

export function sampleHost(): Promise<HostSample> {
  const run = tail.then(readSample, readSample);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readSample(): Promise<HostSample> {
  if (!previous) {
    previous = await counters();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const now = await counters();
  const sample = diff(previous, now, await memory());
  previous = now;
  return sample;
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

async function memory(): Promise<{ usedBytes: number; totalBytes: number }> {
  if (process.platform === 'linux') {
    try {
      const text = await fs.readFile('/proc/meminfo', 'utf8');
      const total = Number(text.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      const available = Number(text.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      if (total > 0) return { usedBytes: Math.max(0, total - available), totalBytes: total };
    } catch {
      /* use the portable counters */
    }
  }
  const totalBytes = os.totalmem();
  return { usedBytes: Math.max(0, totalBytes - os.freemem()), totalBytes };
}

async function networkBytes(): Promise<{ rx: number; tx: number } | null> {
  if (process.platform === 'linux') {
    const text = await fs.readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    let any = false;
    for (const line of text.split('\n').slice(2)) {
      const match = line.match(/^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (!match) continue;
      if (match[1]?.trim() === 'lo') continue;
      rx += Number(match[2]);
      tx += Number(match[3]);
      any = true;
    }
    return any ? { rx, tx } : null;
  }
  if (process.platform !== 'win32') return null;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('netstat', ['-e'], { timeout: 3000, windowsHide: true }, (error, out) => {
      if (error) reject(error);
      else resolve(out);
    });
  });
  const line = stdout
    .split('\n')
    .map((row) => row.trim())
    .find((row) => /\d+\s+\d+$/.test(row));
  const numbers = line?.match(/(\d+)\s+(\d+)$/);
  if (!numbers) return null;
  const rx = Number(numbers[1]);
  const tx = Number(numbers[2]);
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return { rx, tx };
}

async function counters(): Promise<Counters> {
  const cpu = cpuTimes();
  const net = await networkBytes().catch(() => null);
  return { at: Date.now(), idle: cpu.idle, total: cpu.total, rx: net?.rx ?? null, tx: net?.tx ?? null };
}

function diff(before: Counters, now: Counters, ram: { usedBytes: number; totalBytes: number }): HostSample {
  const cpuSpan = now.total - before.total;
  const idleSpan = now.idle - before.idle;
  const cpu = cpuSpan > 0 ? Math.round(Math.min(100, Math.max(0, (1 - idleSpan / cpuSpan) * 100))) : null;
  const seconds = (now.at - before.at) / 1000;
  let rxBytesPerSec: number | null = null;
  let txBytesPerSec: number | null = null;
  if (seconds >= 0.2 && before.rx != null && now.rx != null && before.tx != null && now.tx != null) {
    const down = (now.rx - before.rx) / seconds;
    const up = (now.tx - before.tx) / seconds;
    if (down >= 0 && up >= 0) {
      rxBytesPerSec = down;
      txBytesPerSec = up;
    }
  }
  return { memory: ram, cpu, network: { rxBytesPerSec, txBytesPerSec } };
}
