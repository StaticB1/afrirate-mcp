/**
 * An in-memory MCP client wired to the real server, so tests exercise the tools
 * the way a judge's agent will: through registerTool, schema validation and the
 * structured-content contract, not by calling the handlers directly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AfriRateClient } from '../src/afrirate.js';
import { loadConfig, type Config } from '../src/config.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer } from '../src/server.js';
import { WatchStore } from '../src/watches.js';

export interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  api: AfriRateClient;
  config: Config;
  store: WatchStore;
  close(): Promise<void>;
}

export interface ToolReply {
  text: string;
  structured: Record<string, unknown> | undefined;
  isError: boolean;
}

export async function harness(env: Record<string, string>): Promise<Harness> {
  const stateDir = env.AFRIRATE_STATE_DIR ?? (await mkdtemp(join(tmpdir(), 'afrirate-mcp-test-')));
  const config = loadConfig({ AFRIRATE_MCP_API_KEY: 'test-key', ...env, AFRIRATE_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
  const api = new AfriRateClient(config);
  const store = new WatchStore(config.stateDir);
  const server = createMcpServer(config, api, store);
  const client = new Client({ name: 'test', version: '0.0.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    api,
    config,
    store,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      return {
        text: content.map((c) => c.text ?? '').join('\n'),
        structured: result.structuredContent as Record<string, unknown> | undefined,
        isError: result.isError === true,
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
