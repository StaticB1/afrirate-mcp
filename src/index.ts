import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AfriRateClient } from './afrirate.js';
import { loadConfig } from './config.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

const config = loadConfig();
const health = new AfriRateClient(config);

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** JSON-RPC shaped rejection, so a confused client gets something it can parse. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless: a server and a transport per request, both torn down with it.
  const server = createMcpServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) rpcError(res, 500, 'Internal server error');
  }
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/mcp') {
    if (req.method === 'POST') {
      void handleMcp(req, res);
      return;
    }
    // Stateless mode has no stream to resume and no session to delete.
    rpcError(res, 405, 'This endpoint is stateless: use POST for MCP requests.');
    return;
  }

  if (url.pathname === '/healthz' && req.method === 'GET') {
    void health
      .health()
      .then(({ data }) => json(res, 200, { server: SERVER_NAME, version: SERVER_VERSION, upstream: data.status }))
      .catch((err: Error) => json(res, 503, { server: SERVER_NAME, version: SERVER_VERSION, upstream: err.message }));
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
