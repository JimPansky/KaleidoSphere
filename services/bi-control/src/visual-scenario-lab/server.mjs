import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadVisualScenarioFixtures, runScenarioSession } from './scenario-engine.mjs';

const host = process.env.VISUAL_LAB_HOST ?? '127.0.0.1';
const port = Number(process.env.VISUAL_LAB_PORT ?? 41737);
const webRoot = fileURLToPath(new URL('../../web/visual-scenario-lab/', import.meta.url));
const sessions = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const { oracle, suite } = await loadVisualScenarioFixtures();
      return json(response, 200, { company: oracle.company, asOf: oracle.asOf, scenarios: suite.scenarios.map(({ id, title, utterance }) => ({ id, title, utterance })) });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/run/')) {
      const scenarioId = decodeURIComponent(url.pathname.slice('/api/run/'.length));
      const session = await runScenarioSession(scenarioId);
      const sessionId = `${scenarioId}-${Date.now()}`;
      sessions.set(sessionId, session);
      return json(response, 200, { sessionId, ...session.result });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/undo/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/api/undo/'.length));
      const session = sessions.get(sessionId);
      if (!session?.lastUndoToken) return json(response, 409, { code: 'UNDO_NOT_AVAILABLE' });
      const receipt = session.adapter.undo(session.lastUndoToken, session.adapter.read().version);
      session.lastUndoToken = null;
      return json(response, 200, { receipt, actualState: session.adapter.read() });
    }
    if (request.method !== 'GET') return json(response, 405, { code: 'METHOD_NOT_ALLOWED' });

    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = resolve(webRoot, requested);
    if (!file.startsWith(`${resolve(webRoot)}/`) && file !== resolve(webRoot, 'index.html')) return json(response, 403, { code: 'PATH_DENIED' });
    await stat(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  } catch (error) {
    json(response, error.code === 'SCENARIO_UNKNOWN' ? 404 : 500, { code: error.code ?? 'VISUAL_LAB_ERROR' });
  }
});

server.listen(port, host, () => process.stdout.write(`visual-scenario-lab http://${host}:${port}\n`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
