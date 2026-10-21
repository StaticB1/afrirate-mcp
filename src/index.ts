import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { callerKey, countToolCalls, FreeAllowance, limitMessage } from './access.js';
import { AfriRateClient } from './afrirate.js';
import { loadConfig } from './config.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { WatchStore } from './watches.js';

const config = loadConfig();
// One client, one cache, for the life of the process. See server.ts.
const client = new AfriRateClient(config);
const store = new WatchStore(config.stateDir);
const allowance = new FreeAllowance({ perMinute: config.freePerMinute, perDay: config.freePerDay });

/** nginx sets X-Real-IP from the proxy-protocol address and overwrites any a client sends. */
function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  return (Array.isArray(real) ? real[0] : real) || req.socket.remoteAddress || 'unknown';
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** JSON-RPC shaped rejection, so a confused client gets something it can parse. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    rpcError(res, 400, 'Parse error: the request body is not JSON');
    return;
  }

  // A caller's own key: served on it, so AfriRate applies and meters their plan.
  // No key: the shared client, inside the keyless allowance. See access.ts.
  const key = callerKey(req.headers.authorization, url.searchParams);
  let api = client;
  if (key) {
    // A fresh client and cache per request, so every upstream call is on their key.
    api = new AfriRateClient({ ...config, apiKey: key, keyOwner: 'caller' });
  } else {
    const verdict = allowance.take(clientIp(req), countToolCalls(body));
    if (!verdict.ok) {
      const id = !Array.isArray(body) && typeof body === 'object' && body !== null ? (body as { id?: unknown }).id ?? null : null;
      // 200 with a JSON-RPC error, not a bare 429: MCP clients show the message
      // to the model, and the message is what tells it how to get more.
      res.setHeader('retry-after', String(verdict.retryAfterSec));
      json(res, 200, { jsonrpc: '2.0', error: { code: -32029, message: limitMessage(allowance.limits, verdict) }, id });
      return;
    }
  }

  // Stateless: a server and a transport per request, both torn down with it.
  const server = createMcpServer(config, api, store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) rpcError(res, 500, 'Internal server error');
  }
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/mcp') {
    if (req.method === 'POST') {
      void handleMcp(req, res, url);
      return;
    }
    // Stateless mode has no stream to resume and no session to delete.
    rpcError(res, 405, 'This endpoint is stateless: use POST for MCP requests.');
    return;
  }

  if (url.pathname === '/healthz' && req.method === 'GET') {
    // Quota and cache figures ride along: the question behind "is it up" during
    // judging is usually "have we got requests left", and that is unanswerable
    // from the outside.
    const base = {
      server: SERVER_NAME,
      version: SERVER_VERSION,
      quota: client.quota(),
      cache: client.cacheStats(),
    };
    void client
      .health()
      .then(({ data }) => json(res, 200, { ...base, upstream: data.status, quota: client.quota() }))
      .catch((err: Error) => json(res, 503, { ...base, upstream: err.message, quota: client.quota() }));
    return;
  }

  json(res, 404, { error: 'not_found', message: 'MCP endpoint is POST /mcp' });
});

httpServer.listen(config.port, config.host, () => {
  const keyState = config.apiKey ? 'configured' : 'MISSING — only the free endpoints will answer';
  console.log(`${SERVER_NAME} MCP server ${SERVER_VERSION} on http://${config.host}:${config.port}/mcp`);
  console.log(`  upstream: ${config.apiBase}`);
  console.log(`  api key:  ${keyState}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
  });
}
