// HTTP routes: the browser API for humans, the MCP endpoint for agents, and the web UI.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMcpServer } from './mcp';
import { AppError, type MeetingService, type Participant } from './service';

export interface AppOptions {
  service: MeetingService;
  /** How long wait_for_turn holds a request open. */
  longPollMs?: number;
  webDir?: string;
}

export function createApp({ service, longPollMs = 25_000, webDir = path.resolve(process.cwd(), 'dist/web') }: AppOptions) {
  const app = new Hono<{ Variables: { me: Participant } }>();

  // Secret links live in URLs, so never leak them through the Referer header or caches.
  app.use('*', async (c, next) => {
    await next();
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/mcp')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid', message: 'The request body is not valid JSON.' }, 400);
    console.error(err);
    return c.json({ error: 'internal', message: 'Something went wrong.' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // ---------- humans ----------

  app.post('/api/meetings', async (c) => c.json(await service.createMeeting(await c.req.json()), 201));

  const human = new Hono<{ Variables: { me: Participant } }>();
  human.use('*', async (c, next) => {
    c.set('me', await service.byHumanToken(c.req.param('token') ?? ''));
    await next();
  });
  const done = { ok: true };
  human.get('/state', async (c) => c.json(await service.humanView(c.var.me)));
  human.post('/participants', async (c) => c.json(await service.addParticipant(c.var.me, (await c.req.json()).name), 201));
  human.post('/participants/:id/rotate-agent-link', async (c) => {
    await service.rotateAgentLink(c.var.me, c.req.param('id'));
    return c.json(done);
  });
  human.post('/sharing-note', async (c) => {
    await service.setSharingNote(c.var.me, (await c.req.json()).note);
    return c.json(done);
  });
  human.post('/agenda', async (c) => {
    await service.addAgendaItem(c.var.me, await c.req.json());
    return c.json(done, 201);
  });
  human.post('/tasks', async (c) => {
    await service.addTask(c.var.me, await c.req.json());
    return c.json(done, 201);
  });
  human.post('/control', async (c) => {
    await service.control(c.var.me, (await c.req.json()).action);
    return c.json(done);
  });
  human.post('/messages', async (c) => {
    await service.humanMessage(c.var.me, (await c.req.json()).text);
    return c.json(done, 201);
  });
  human.post('/takeaways/:id', async (c) => {
    await service.decideTakeaway(c.var.me, c.req.param('id'), (await c.req.json()).decision);
    return c.json(done);
  });
  human.post('/agent-key/confirm', async (c) => {
    await service.confirmKey(c.var.me);
    return c.json(done);
  });
  human.post('/agent-key/reset', async (c) => {
    await service.resetKey(c.var.me);
    return c.json(done);
  });
  human.get('/events', (c) => {
    const meetingId = c.var.me.meetingId;
    return streamSSE(c, async (stream) => {
      let open = true;
      let dirty = true;
      let wake: (() => void) | null = null;
      const off = service.onChange(meetingId, () => {
        dirty = true;
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      while (open) {
        await stream.writeSSE(dirty ? { event: 'changed', data: String(Date.now()) } : { event: 'ping', data: '' });
        dirty = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      off();
    });
  });
  app.route('/api/h/:token', human);

  // ---------- agents ----------

  const handleMcp = async (request: Request, token: string | undefined) => {
    const me = token ? await service.byAgentToken(token) : null;
    if (!me) {
      return Response.json({ error: 'unauthorized', message: 'This agent link is not valid. Ask the meeting host for a new one.' }, { status: 401 });
    }
    if (request.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed', message: 'Use POST.' }, { status: 405, headers: { Allow: 'POST' } });
    }
    await service.touch(me);
    // Stateless: a fresh server per request, bound to exactly one participant.
    const server = buildMcpServer(service, me, { longPollMs });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
  app.all('/mcp/:token', (c) => handleMcp(c.req.raw, c.req.param('token')));
  app.all('/mcp', (c) => handleMcp(c.req.raw, c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]));

  // ---------- downloads ----------

  // The bridge as a single file, so a guest needs only Node to run it.
  app.get('/download/agentxchange-bridge.mjs', (c) => {
    const file = path.resolve(webDir, '..', 'bridge.js');
    if (!existsSync(file)) return c.text('The bridge has not been built yet. Run: npm run build', 503);
    return c.body(readFileSync(file, 'utf8'), 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'attachment; filename="agentxchange-bridge.mjs"',
    });
  });

  // ---------- web UI ----------

  app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such endpoint.' }, 404));
  if (existsSync(path.join(webDir, 'index.html'))) {
    const index = readFileSync(path.join(webDir, 'index.html'), 'utf8');
    app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), webDir) || '.' }));
    app.get('*', (c) => c.html(index));
  } else {
    app.get('*', (c) => c.text('The web UI has not been built yet. Run: npm run build', 503));
  }

  return app;
}
