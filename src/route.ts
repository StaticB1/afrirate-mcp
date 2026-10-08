import type { AfriRateClient, Rate } from './afrirate.js';
import { bestRate, toNumber } from './format.js';

/** One hop in a conversion: the row we used, and whether we read it backwards. */
export interface Leg {
  row: Rate;
  inverted: boolean;
  factor: number;
}

export interface Route {
  legs: Leg[];
  path: 'direct' | 'inverse' | 'cross-usd';
  /** Units of `to` per one unit of `from`, across every leg. */
  rate: number;
  stale: boolean;
  sources: string[];
  /** The oldest leg's observation date — the honest "as of" for the whole route. */
  asOf: string;
}

export interface RouteOptions {
  country?: string;
  source?: string;
}

/**
 * Rows for base→quote, optionally restricted to the sources of one country.
 * The country form returns every pair that country publishes, so we filter.
 *
 * Note that the country form asks for the identical URL on every leg — direct,
 * inverse and both halves of a cross — so the client's cache collapses what
 * used to be up to six upstream requests into one. Nothing here needs to know
 * that; it is why this stayed simple.
 */
async function pairRows(
  client: AfriRateClient,
  base: string,
  quote: string,
  country?: string,
): Promise<Rate[]> {
  if (country) {
    const { data } = await client.rates({ country });
    return data.rates.filter((r) => r.base === base && r.quote === quote);
  }
  const { data } = await client.rates({ base, quote });
  return data.rates;
}

const STOPWORDS = new Set(['of', 'the', 'and', 'de', 'du', 'la']);

/**
 * Does `asked` name this source? Sources are short codes (`cbk`, `rbz`,
 * `sarb`), but a model asked about "the Central Bank of Kenya" passes the
 * name. Initials cover nearly every central bank — with and without the small
 * words, because "Bank of Botswana" is `bob` while "Reserve Bank of Zimbabwe"
 * is `rbz`.
 */
export function sourceMatches(code: string, asked: string): boolean {
  const c = code.toLowerCase();
  const a = asked.toLowerCase().trim();
  if (a === c) return true;
  const words = a.split(/[^a-z]+/).filter(Boolean);
  if (words.length < 2) return false;
  const all = words.map((w) => w[0]).join('');
  const content = words.filter((w) => !STOPWORDS.has(w)).map((w) => w[0]).join('');
  return c === all || c === content;
}

function pick(rows: Rate[], source?: string): Rate | undefined {
  const filtered = source ? rows.filter((r) => sourceMatches(r.source, source)) : rows;
  return bestRate(filtered);
}

/** Direct, then inverse. Returns undefined rather than throwing so the caller can try a cross. */
async function resolveDirect(
  client: AfriRateClient,
  from: string,
  to: string,
  opts: RouteOptions,
): Promise<Leg | undefined> {
  const direct = pick(await pairRows(client, from, to, opts.country), opts.source);
  if (direct) {
    const factor = toNumber(direct.rate);
    if (factor !== null && factor > 0) return { row: direct, inverted: false, factor };
  }

  const inverse = pick(await pairRows(client, to, from, opts.country), opts.source);
  if (inverse) {
    const rate = toNumber(inverse.rate);
    if (rate !== null && rate > 0) return { row: inverse, inverted: true, factor: 1 / rate };
  }

  return undefined;
}

/**
 * The best published route from one currency to another: direct, then inverse,
 * then a cross through USD. Undefined when nothing connects them. Upstream
 * errors — a throttle included — propagate, so a caller can tell "no such
 * rate" from "could not ask".
 */
export async function resolveRoute(
  client: AfriRateClient,
  from: string,
  to: string,
  opts: RouteOptions = {},
): Promise<Route | undefined> {
  const legs: Leg[] = [];
  let path: Route['path'];

  const oneHop = await resolveDirect(client, from, to, opts);
  if (oneHop) {
    legs.push(oneHop);
    path = oneHop.inverted ? 'inverse' : 'direct';
  } else {
    // Nothing quotes this pair. Almost every African source quotes against
    // USD, so a cross through it is the difference between an answer and a
    // shrug.
    const first = await resolveDirect(client, from, 'USD', opts);
    const second = await resolveDirect(client, 'USD', to, opts);
    if (!first || !second) return undefined;
    legs.push(first, second);
    path = 'cross-usd';
  }

  return {
    legs,
    path,
    rate: legs.reduce((acc, leg) => acc * leg.factor, 1),
    stale: legs.some((leg) => leg.row.stale),
    sources: legs.map((leg) => leg.row.source),
    asOf: legs.map((leg) => leg.row.rate_date).sort()[0]!,
  };
}
