/**
 * A stand-in AfriRate API, so the tests can prove how many upstream requests a
 * tool call costs without spending any of the real 10-per-minute budget.
 *
 * Every request is recorded. `hits()` is the assertion that matters in most of
 * these tests: the bugs being pinned here are all "this asked upstream more
 * times than it needed to" or "this reported a throttle as an absence".
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Rate } from '../src/afrirate.js';

export interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Stub {
  base: string;
  /** Every path+query asked for, in order, including repeats. */
  requests: string[];
  hits(pathAndQuery?: string): number;
  reset(): void;
  close(): Promise<void>;
}

export const TODAY = new Date().toISOString().slice(0, 10);

export function rate(over: Partial<Rate> = {}): Rate {
  return {
    source: 'cbk',
    base: 'USD',
    quote: 'KES',
    rate: '129.0',
    bid: null,
    ask: null,
    rate_date: TODAY,
    updated_at: `${TODAY}T07:00:00.000Z`,
    stale: false,
    ...over,
  };
}

export function ratesEnvelope(rates: Rate[], country: string | null = null): unknown {
  return {
    data: { country, rates },
    meta: { timestamp: new Date().toISOString(), count: rates.length },
  };
}

/** `handler` sees the path with its query string, e.g. `/rates/latest?base=USD&quote=KES`. */
export async function startStub(handler: (target: URL) => StubReply): Promise<Stub> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const target = new URL(req.url ?? '/', 'http://stub');
    requests.push(target.pathname + (target.search || ''));
    const reply = handler(target);
    const payload = JSON.stringify(reply.body ?? {});
    res.writeHead(reply.status ?? 200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...reply.headers,
    });
    res.end(payload);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    hits(pathAndQuery?: string) {
      if (pathAndQuery === undefined) return requests.length;
      return requests.filter((r) => r === pathAndQuery || r.startsWith(`${pathAndQuery}?`)).length;
    },
    reset() {
      requests.length = 0;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
