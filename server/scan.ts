import { execFile } from 'node:child_process';
import { ApiError } from './errors.js';

let found: Promise<string | null> | null = null;

function run(command: string, args: string[], timeout: number): Promise<{ code: number | null; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error) => {
      const err = error as NodeJS.ErrnoException | null;
      if (err?.code === 'ENOENT') {
        resolve({ code: null, missing: true });
        return;
      }
      const status = typeof err?.code === 'number' ? err.code : err ? 2 : 0;
      resolve({ code: status, missing: false });
    });
  });
}

export function clamCommand(): Promise<string | null> {
  found ??= (async () => {
    for (const command of ['clamdscan', 'clamscan']) {
      const result = await run(command, ['--version'], 5000);
      if (!result.missing) return command;
    }
    return null;
  })();
  return found;
}

export async function scanFile(abs: string): Promise<void> {
  const command = await clamCommand();
  if (!command) return;
  const first = command === 'clamdscan' ? await run(command, ['--no-summary', abs], 60_000) : await run(command, ['--no-summary', abs], 120_000);
  const result = first.code === 2 && command === 'clamdscan' ? await run('clamscan', ['--no-summary', abs], 120_000) : first;
  if (result.missing || result.code === 0) return;
  if (result.code === 1) throw new ApiError(400, 'infected', 'That file was blocked by the virus scan.');
  throw new ApiError(503, 'scan_failed', 'The virus scan could not finish.');
}
