/**
 * A simulated Alexa+ device for AfriRate MCP.
 *
 * The browser page (demo/public/index.html) is the device: a smart display
 * with a microphone, a speaker and a screen for cards. This server is the
 * voice service behind it. It hands each utterance to a model with the
 * AfriRate MCP server attached as a remote tool, so the model — not this
 * file — decides which MCP tools to call, and the MCP server is reached over
 * Streamable HTTP exactly as an Alexa+ integration would reach it.
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

const OPENAI = 'https://api.openai.com/v1';
const KEY = process.env.OPENAI_API_KEY;
const MCP_URL = process.env.MCP_URL ?? 'https://mcp.afrirate.statotec.com/mcp';
const MODEL = process.env.DEMO_MODEL ?? 'gpt-4.1-mini';
const VOICE = process.env.DEMO_VOICE ?? 'sage';
const PORT = Number(process.env.DEMO_PORT ?? 4173);
const HOST = process.env.DEMO_HOST ?? '127.0.0.1';
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

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

interface McpCall {
  name: string;
  arguments: unknown;
  output: string | null;
  error: string | null;
}

interface ResponseItem {
  type: string;
  name?: string;
  arguments?: string;
  output?: string | null;
  error?: unknown;
  content?: { type: string; text?: string }[];
}

async function ask(text: string, previousId: string | null, watchlist: string | null) {
  const res = await fetch(`${OPENAI}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      instructions: sessionInstructions(watchlist, previousId === null),
      input: text,
      ...(previousId ? { previous_response_id: previousId } : {}),
      tools: [{ type: 'mcp', server_label: 'afrirate', server_url: MCP_URL, require_approval: 'never' }],
      // One call at a time. Two watch_rate calls in parallel cannot share the
      // watchlist id the first one creates, so they would land in two lists.
      parallel_tool_calls: false,
      // Low, for a device: the same question should get the same answer.
      temperature: 0.2,
    }),
  });
  const body = (await res.json()) as { id?: string; output?: ResponseItem[]; error?: { message: string } };
  if (!res.ok || !body.output) throw new Error(body.error?.message ?? `model request failed (${res.status})`);

  const calls: McpCall[] = body.output
    .filter((item) => item.type === 'mcp_call')
    .map((item) => {
      let args: unknown = item.arguments;
      try {
        args = JSON.parse(item.arguments ?? '{}');
      } catch {
        // Keep the raw string; the card shows it as-is.
      }
      // A tool that answered isError comes back as a JSON-encoded
      // mcp_tool_execution_error — in `error`, and in some responses in
      // `output`. Unwrap it to the tool's own text.
      const raw = item.error ?? (item.output?.startsWith('{"type":"mcp_tool_execution_error"') ? item.output : null);
      let error: string | null = null;
      if (raw) {
        const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
        try {
          const parsed = JSON.parse(str) as { content?: { text?: string }[] };
          error = parsed.content?.map((c) => c.text ?? '').join('\n') || str;
        } catch {
          error = str;
        }
      }
      return { name: item.name ?? '?', arguments: args, output: error ? null : (item.output ?? null), error };
    });

  const reply = body.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((c) => c.text ?? '')
    .join(' ')
    .trim();

  // A watchlist id can only come from a watch_rate the user asked for. Pick it
  // up so the page can keep it — that is the "device" remembering its owner.
  const created = calls
    .filter((c) => c.name === 'watch_rate' && c.output)
    .map((c) => /\bwl_[a-z2-9]{10}\b/.exec(c.output!)?.[0])
    .find(Boolean);

  return { reply, calls, response_id: body.id ?? null, watchlist: created ?? watchlist };
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
  console.log(`Alexa+ simulator for AfriRate MCP: http://${HOST}:${PORT}  (MCP: ${MCP_URL}, model: ${MODEL})`);
});
