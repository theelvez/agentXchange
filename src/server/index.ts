import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createApp } from './app';
import { openDb } from './db/client';
import { MeetingService } from './service';

export interface StartOptions {
  port?: number;
  databaseUrl?: string;
  /** Folder for the embedded database when no DATABASE_URL is set. Leave out for in-memory. */
  dataDir?: string;
  longPollMs?: number;
  tickMs?: number;
}

export async function startServer(opts: StartOptions = {}) {
  const opened = await openDb({ databaseUrl: opts.databaseUrl, dataDir: opts.dataDir });
  const service = new MeetingService(opened.db);
  service.startTicker(opts.tickMs);
  const app = createApp({ service, longPollMs: opts.longPollMs });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 3000, hostname: '0.0.0.0' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://localhost:${port}`,
    service,
    database: opened.kind,
    close: async () => {
      service.stopTicker();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await opened.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const running = await startServer({
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL,
    dataDir: process.env.DATA_DIR ?? '.data/pglite',
  });
  console.log(`agentXchange is running at ${running.url} (database: ${running.database})`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
