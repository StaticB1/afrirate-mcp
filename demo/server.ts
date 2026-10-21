/**
 * A simulated Alexa+ device for AfriRate MCP, and an MCP Apps host.
 *
 * The browser page (demo/public/index.html) is the device: a smart display
 * with a microphone, a speaker and a screen. This server is the voice service
 * behind it and the device's MCP client. It connects to the AfriRate MCP
 * server over Streamable HTTP, offers the server's tools to a model as
 * functions, and runs whatever the model calls — so the model decides which
 * tools to use, and this host holds every full CallToolResult. The page then
 * renders each result in the view the tool names in `_meta.ui.resourceUri`:
 * HTML the MCP server itself serves, loaded in a sandbox on a second origin as
 * the MCP Apps spec (2026-01-26) requires of a web host. Buttons in a view
 * call tools back through /api/tool.
 *
 * It holds an OpenAI key, so it binds to localhost and is meant to be run by
 * whoever is looking at it, with their own key:
 *
 *   OPENAI_API_KEY=sk-... npm run demo     # then open http://127.0.0.1:4173
 *
 * Nothing here talks to AfriRate directly. Every rate on screen came back
 * through an MCP tool call, and the card shows which.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const OPENAI = 'https://api.openai.com/v1';
const KEY = process.env.OPENAI_API_KEY;
const MCP_URL = process.env.MCP_URL ?? 'https://mcp.afrirate.statotec.com/mcp';
const MODEL = process.env.DEMO_MODEL ?? 'gpt-4.1-mini';
const VOICE = process.env.DEMO_VOICE ?? 'sage';
const PORT = Number(process.env.DEMO_PORT ?? 4173);
const HOST = process.env.DEMO_HOST ?? '127.0.0.1';
// The sandbox must be a different origin from the page; 127.0.0.1 and
// localhost are different origins to a browser.
const SANDBOX_PORT = Number(process.env.DEMO_SANDBOX_PORT ?? PORT + 1);
const SANDBOX_URL = `http://localhost:${SANDBOX_PORT}/sandbox.html`;
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const UI_MIME_TYPE = 'text/html;profile=mcp-app';

if (!KEY) {
  console.error('OPENAI_API_KEY is not set. The demo needs it to run the voice assistant.');
  process.exit(1);
}

const PERSONA =
  'You are a voice assistant on a smart display, answering out loud. AfriRate gives you exchange rates, ' +
  'inflation and gold prices for 28 African countries through its tools; use them for any question about ' +
  'money, rates or prices in Africa, and never answer a rate from memory. Speak in at most two short ' +
  'sentences, and never end with a question or an offer of more help. No markdown, lists or symbols — this is read aloud and shown on screen. Always write numbers ' +
  'as digits, e.g. "250 US dollars is 32,472 Kenyan shillings", never "two hundred fifty" — the speech ' +
  'engine reads digits correctly. ' +
  'Write currency names in words ("Kenyan shillings"), round to sensible precision, and name ' +
  'the source once ("from the Central Bank of Kenya"). If a tool call fails, say briefly what went wrong. ' +
  'If a tool says a rate is days or weeks old, or a source has published nothing new, say so plainly — that ' +
  'is part of the answer, not a caveat to skip. ZWG, "ZiG" or "Zimbabwe Gold" is Zimbabwe\'s currency, not a ' +
  'price of gold; call it Zimbabwe Gold. The screen shows the details, so do not read out ids, ' +
  'tables or every source. When you set a watch, say that it is saved and that you will check it next time; ' +
  'do not read the watchlist id aloud. To set several watches, set the first, then pass the watchlist id it ' +
  'returns to every later watch_rate, so they share one list. When a watch fires, say where the rate stands against the threshold; ' +
  'do not claim it just moved unless check_watches reports a change since the last check. Only give dates a ' +
  'tool returned, as dates ("7 October"); never say "today" or "latest" for a rate unless its date is today.';

function sessionInstructions(watchlist: string | null, newSession: boolean): string {
  if (!watchlist) return PERSONA;
  const opener = newSession
    ? ' This is the start of a new conversation. Before answering anything else, call check_watches for ' +
      'that watchlist and lead with anything that fired; if nothing fired, say so in one sentence and move on.'
    : '';
  return `${PERSONA}\n\nThe user has a saved AfriRate watchlist: ${watchlist}. Use it for check_watches, ` +
    `and pass it as \`watchlist\` to watch_rate so new watches join the same list.${opener}`;
}

// ---------------------------------------------------------------- MCP client

const mcp = new Client(
  { name: 'afrirate-alexa-simulator', version: '0.2.0' },
  // Tell the server this host renders MCP Apps views.
  { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME_TYPE] } } } } as never,
);
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
const tools: Tool[] = (await mcp.listTools()).tools;
const toolByName = new Map(tools.map((t) => [t.name, t]));

type UiMeta = { ui?: { resourceUri?: string; visibility?: string[] } };
const viewOf = (t: Tool | undefined): string | null => (t?._meta as UiMeta | undefined)?.ui?.resourceUri ?? null;
// Per the spec, a view may only call tools whose visibility includes "app" (the default).
const appCallable = (t: Tool | undefined): boolean =>
  !!t && ((t._meta as UiMeta | undefined)?.ui?.visibility ?? ['model', 'app']).includes('app');
const modelTools = tools.filter((t) => ((t._meta as UiMeta | undefined)?.ui?.visibility ?? ['model']).includes('model'));

const FUNCTIONS = modelTools.map((t) => ({
  type: 'function',
  name: t.name,
  description: t.description ?? '',
  parameters: t.inputSchema,
  strict: false,
}));

const textOf = (r: CallToolResult): string =>
  (r.content ?? []).map((c) => ('text' in c ? c.text : '')).join('\n');

async function runTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

const views = new Map<string, string>();
async function viewHtml(uri: string): Promise<string> {
  if (!views.has(uri)) {
    const { contents } = await mcp.readResource({ uri });
    const c = contents[0] as { mimeType?: string; text?: string } | undefined;
    if (!c?.text || c.mimeType !== UI_MIME_TYPE) throw new Error(`${uri} is not an MCP Apps view`);
    views.set(uri, c.text);
  }
  return views.get(uri)!;
}

// ------------------------------------------------------------------- model

interface HostCall {
  name: string;
  arguments: Record<string, unknown>;
  result: CallToolResult;
  /** The MCP Apps view the tool names, or null if it has none. */
  view: string | null;
  output: string | null;
  error: string | null;
}

interface ResponseItem {
  type: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  content?: { type: string; text?: string }[];
}

async function responses(body: Record<string, unknown>) {
  const res = await fetch(`${OPENAI}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: string; output?: ResponseItem[]; error?: { message: string } };
  if (!res.ok || !json.output) throw new Error(json.error?.message ?? `model request failed (${res.status})`);
  return json as { id: string; output: ResponseItem[] };
}

/**
 * One user turn: the model calls tools, this host runs them on the MCP server
 * and hands back their text, until the model answers.
 */
async function ask(text: string, previousId: string | null, watchlist: string | null) {
  const instructions = sessionInstructions(watchlist, previousId === null);
  const calls: HostCall[] = [];
  let input: unknown = text;
  let previous = previousId;
  let reply = '';

  for (let round = 0; round < 8; round++) {
    const body = await responses({
      model: MODEL,
      instructions,
      input,
      ...(previous ? { previous_response_id: previous } : {}),
      tools: FUNCTIONS,
      // One call at a time. Two watch_rate calls in parallel cannot share the
      // watchlist id the first one creates, so they would land in two lists.
      parallel_tool_calls: false,
      // Low, for a device: the same question should get the same answer.
      temperature: 0.2,
    });
    previous = body.id;

    const requested = body.output.filter((i) => i.type === 'function_call');
    if (requested.length === 0) {
      reply = body.output
        .filter((i) => i.type === 'message')
        .flatMap((i) => i.content ?? [])
        .map((c) => c.text ?? '')
        .join(' ')
        .trim();
      break;
    }

    const outputs = [];
    for (const fc of requested) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fc.arguments ?? '{}') as Record<string, unknown>;
      } catch {
        // The model sent malformed JSON; run with nothing and let the tool say what is missing.
      }
      const name = fc.name ?? '?';
      const result = toolByName.has(name)
        ? await runTool(name, args)
        : ({ content: [{ type: 'text', text: `No tool called ${name}.` }], isError: true } as CallToolResult);
      const out = textOf(result);
      calls.push({
        name,
        arguments: args,
        result,
        view: viewOf(toolByName.get(name)),
        output: result.isError ? null : out,
        error: result.isError ? out : null,
      });
      outputs.push({ type: 'function_call_output', call_id: fc.call_id, output: (result.isError ? 'Tool error: ' : '') + out });
    }
    input = outputs;
  }

  // A watchlist id can only come from a watch_rate the user asked for. Pick it
  // up so the page can keep it — that is the "device" remembering its owner.
  const created = calls
    .filter((c) => c.name === 'watch_rate' && !c.result.isError)
    .map((c) => (c.result.structuredContent as { watchlist?: string } | undefined)?.watchlist)
    .find(Boolean);

  return { reply, calls, response_id: previous, watchlist: created ?? watchlist };
}

async function speak(text: string, voice: string): Promise<ArrayBuffer> {
  const res = await fetch(`${OPENAI}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice,
      input: text,
      instructions: 'A warm, clear smart-speaker voice. Natural pace, friendly, never rushed.',
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`speech request failed (${res.status}): ${await res.text()}`);
  return res.arrayBuffer();
}

async function transcribe(audio: Buffer, type: string): Promise<string> {
  const form = new FormData();
  form.append('model', 'gpt-4o-mini-transcribe');
  form.append('file', new Blob([new Uint8Array(audio)], { type }), type.includes('ogg') ? 'speech.ogg' : 'speech.webm');
  const res = await fetch(`${OPENAI}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}` },
    body: form,
  });
  const body = (await res.json()) as { text?: string; error?: { message: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `transcription failed (${res.status})`);
  return body.text ?? '';
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://demo');
  try {
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const { text, previous_response_id, watchlist } = JSON.parse((await readBody(req, 16_384)).toString()) as {
        text?: string;
        previous_response_id?: string | null;
        watchlist?: string | null;
      };
      if (!text || text.length > 500) return send(res, 400, { error: 'text must be 1–500 characters' });
      const list = watchlist && /^wl_[a-z2-9]{10}$/.test(watchlist) ? watchlist : null;
      return send(res, 200, await ask(text, previous_response_id ?? null, list));
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { sandbox: SANDBOX_URL, mcp: MCP_URL });
    }

    if (req.method === 'GET' && url.pathname === '/api/view') {
      const uri = url.searchParams.get('uri') ?? '';
      if (!uri.startsWith('ui://')) return send(res, 400, { error: 'uri must be a ui:// resource' });
      const html = await viewHtml(uri);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // A view calling a tool back through the host (spec: tools/call from the View).
    if (req.method === 'POST' && url.pathname === '/api/tool') {
      const { name, arguments: args } = JSON.parse((await readBody(req, 16_384)).toString()) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (!name || !appCallable(toolByName.get(name))) return send(res, 403, { error: `views may not call ${name}` });
      return send(res, 200, await runTool(name, args ?? {}));
    }

    if (req.method === 'POST' && url.pathname === '/api/tts') {
      const { text, voice } = JSON.parse((await readBody(req, 16_384)).toString()) as { text?: string; voice?: string };
      if (!text || text.length > 1000) return send(res, 400, { error: 'text must be 1–1000 characters' });
      const audio = Buffer.from(await speak(text, voice ?? VOICE));
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
      return res.end(audio);
    }

    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      const audio = await readBody(req, 4 * 1024 * 1024);
      return send(res, 200, { text: await transcribe(audio, req.headers['content-type'] ?? 'audio/webm') });
    }

    if (req.method === 'GET') {
      const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
      if (path.includes('..')) return send(res, 400, { error: 'bad path' });
      const file = await readFile(join(PUBLIC, path)).catch(() => null);
      if (!file) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      return res.end(file);
    }

    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    send(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Alexa+ simulator for AfriRate MCP: http://${HOST}:${PORT}  (MCP: ${MCP_URL}, ${tools.length} tools, ` +
      `${tools.filter((t) => viewOf(t)).length} with MCP Apps views, model: ${MODEL})`,
  );
});

// The MCP Apps sandbox proxy, on its own origin. It serves one file.
createServer(async (req, res) => {
  if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://x').pathname !== '/sandbox.html') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await readFile(join(PUBLIC, 'sandbox.html')));
}).listen(SANDBOX_PORT, HOST);
