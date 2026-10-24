import { serve } from '@hono/node-server';
import { warmAuth } from './auth.js';
import { initRuntime, runtime } from './config.js';
import { purgeExpiredTrash } from './files.js';
import { createApp } from './routes.js';

const argv = process.argv.map((part) => part.replace(/\\/g, '/')).join(' ');
const isMain = argv.includes('server/index.ts') || argv.includes('server/index.js');

export { createApp };

if (isMain) {
  await initRuntime();
  await warmAuth();
  const app = createApp();
  void purgeExpiredTrash();
  setInterval(() => void purgeExpiredTrash(), 60 * 60 * 1000);
  const { host, port } = runtime().config;
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`Larder API http://${info.address}:${info.port}`);
  });
  server.on('error', (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
