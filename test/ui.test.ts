/**
 * MCP Apps wiring. What a host relies on: every tool that names a view names
 * one that exists, the view is served with the extension's MIME type, it
 * makes no network requests a default CSP would block, and its script parses.
 * Rendering itself is checked in a browser through demo/, which is a host.
 */
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AfriRateClient } from '../src/afrirate.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/server.js';
import { UI_MIME_TYPE, VIEW_URIS } from '../src/ui/views.js';
import { WatchStore } from '../src/watches.js';

async function connect() {
  const config = loadConfig({ AFRIRATE_MCP_API_KEY: 'k', AFRIRATE_API_BASE: 'http://127.0.0.1:9' } as NodeJS.ProcessEnv);
  const server = createMcpServer(config, new AfriRateClient(config), new WatchStore('/nonexistent'));
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('every tool with a view names a ui:// resource the server serves', async () => {
  const { client, close } = await connect();
  after(close);

  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const served = new Set(resources.map((r) => r.uri));

  const withUi = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri);
  assert.deepEqual(
    withUi.map((t) => t.name).sort(),
    ['check_watches', 'compare_corridor', 'convert', 'get_rate', 'remove_watch', 'watch_rate'],
  );
  for (const t of withUi) {
    const uri = (t._meta as { ui: { resourceUri: string } }).ui.resourceUri;
    assert.ok(uri.startsWith('ui://'), uri);
    assert.ok(served.has(uri), `${t.name} points at ${uri}, which is not served`);
  }
  for (const r of resources.filter((r) => r.uri.startsWith('ui://'))) assert.equal(r.mimeType, UI_MIME_TYPE);
});

test('each view is self-contained HTML with a script that parses', async () => {
  const { client, close } = await connect();
  after(close);

  for (const uri of Object.values(VIEW_URIS)) {
    const { contents } = await client.readResource({ uri });
    const [c] = contents as { uri: string; mimeType?: string; text?: string }[];
    assert.equal(c!.mimeType, UI_MIME_TYPE);
    const html = c!.text ?? '';
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /'ui\/initialize'/);
    assert.match(html, /protocolVersion: '2026-01-26'/);
    // A host's default CSP allows no external origins; anything fetched would fail.
    assert.doesNotMatch(html, /(src|href)=["']https?:/i, `${uri} loads something external`);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    assert.doesNotThrow(() => new Script(script), `${uri} script does not parse`);
  }
});
