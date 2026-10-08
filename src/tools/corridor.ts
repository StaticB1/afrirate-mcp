import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AfriRateError, type AfriRateClient, type Rate } from '../afrirate.js';
import { ageNote, errorResult, textResult, toNumber } from '../format.js';

interface Quote {
  country: string | null;
  source: string;
  rate: number;
  rate_date: string;
  stale: boolean;
  inverted: boolean;
}

/** Something we could not check, as opposed to something that publishes nothing. */
interface Unchecked {
  /** A country code, or the pair direction when comparing every source. */
  target: string;
  reason: string;
}

/** Normalise a country's rows to the requested direction, inverting where needed. */
function quotesFor(rows: Rate[], base: string, quote: string, country: string | null): Quote[] {
  const out: Quote[] = [];
  for (const row of rows) {
    const direct = row.base === base && row.quote === quote;
    const inverse = row.base === quote && row.quote === base;
    if (!direct && !inverse) continue;
    const value = toNumber(row.rate);
    if (value === null || value <= 0) continue;
    out.push({
      country,
      source: row.source,
      rate: direct ? value : 1 / value,
      rate_date: row.rate_date,
      stale: row.stale,
      inverted: inverse,
    });
  }
  return out;
}

/**
 * One quote per source, preferring the direction the source actually publishes.
 *
 * A source can appear twice — once from the forward fetch and once from the
 * reverse — and a country's row set can carry both directions of the same pair.
 * Counting that source twice would invent a second opinion and, worse, invent a
 * spread between a number and its own reciprocal.
 */
function dedupe(quotes: Quote[]): Quote[] {
  const bySource = new Map<string, Quote>();
  for (const candidate of quotes) {
    const key = `${candidate.country ?? ''}:${candidate.source}`;
    const held = bySource.get(key);
    if (!held || (held.inverted && !candidate.inverted)) bySource.set(key, candidate);
  }
  return [...bySource.values()];
}

/** Run `task` over `items`, at most `limit` at a time. */
async function mapWithLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await task(next);
    }
  });
  await Promise.all(workers);
}

function describe(err: unknown): string {
  if (err instanceof AfriRateError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function registerCorridorTool(server: McpServer, client: AfriRateClient): void {
  server.registerTool(
    'compare_corridor',
    {
      title: 'Compare one pair across sources and countries',
      description:
        'Compare the same currency pair across every source that publishes it, and optionally across ' +
        'several countries at once, then report the best and worst quote and the spread between them. ' +
        'This is what 28-country coverage is actually for: answering "where is this corridor cheapest" ' +
        'in one call instead of twenty. Most pairs are published by a single central bank, in which case ' +
        'this says so rather than reporting a spread of zero. Naming countries costs one upstream request ' +
        'each against a 10-per-minute budget; omitting them costs two in total.',
      inputSchema: {
        base: z.string().min(3).max(3).describe('Base currency, e.g. USD'),
        quote: z.string().min(3).max(3).describe('Quote currency, e.g. KES'),
        countries: z
          .array(z.string().length(2))
          .max(10)
          .optional()
          .describe('Restrict to these countries’ sources. Omit to compare every source publishing the pair.'),
      },
      outputSchema: {
        base: z.string(),
        quote: z.string(),
        count: z.number(),
        best: z.object({ country: z.string().nullable(), source: z.string(), rate: z.number() }).optional(),
        worst: z.object({ country: z.string().nullable(), source: z.string(), rate: z.number() }).optional(),
        /** Null when only one source publishes the pair: there is no spread, not a zero one. */
        spread_pct: z.number().nullable(),
        single_source: z.boolean(),
        quotes: z.array(
          z.object({
            country: z.string().nullable(),
            source: z.string(),
            rate: z.number(),
            rate_date: z.string(),
            stale: z.boolean(),
            inverted: z.boolean(),
          }),
        ),
        /** Countries that answered but publish nothing for this pair. */
        unavailable: z.array(z.string()),
        /** Countries we could not check at all — throttled or upstream failure. Absence of data is not implied. */
        errors: z.array(z.object({ target: z.string(), reason: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ base, quote, countries }) => {
      const b = base.toUpperCase();
      const q = quote.toUpperCase();
      if (b === q) return errorResult(`${b} and ${q} are the same currency.`);

      const found: Quote[] = [];
      const unavailable: string[] = [];
      const errors: Unchecked[] = [];
      let throttled: AfriRateError | undefined;

      if (countries && countries.length > 0) {
        const codes = [...new Set(countries.map((c) => c.toUpperCase()))];
        await mapWithLimit(codes, 3, async (code) => {
          // Once the minute's budget is gone every further request is a
          // guaranteed 429. Stop spending and say which countries went unread.
          if (throttled) {
            errors.push({ target: code, reason: 'not checked — the rate limit was already reached' });
            return;
          }
          try {
            const { data } = await client.rates({ country: code });
            const quotes = quotesFor(data.rates, b, q, code);
            if (quotes.length === 0) unavailable.push(code);
            found.push(...quotes);
          } catch (err) {
            if (err instanceof AfriRateError && err.isRateLimited) throttled = err;
            errors.push({ target: code, reason: describe(err) });
          }
        });
      } else {
        // Both directions, always. A source that publishes only the reverse —
        // SARB quotes ZAR/BWP while Botswana quotes BWP/ZAR — is invisible if
        // the reverse fetch is conditional on the forward one being empty.
        const [forward, reverse] = await Promise.allSettled([
          client.rates({ base: b, quote: q }),
          client.rates({ base: q, quote: b }),
        ]);

        for (const [direction, outcome] of [
          [`${b}/${q}`, forward],
          [`${q}/${b}`, reverse],
        ] as const) {
          if (outcome.status === 'rejected') {
            const err: unknown = outcome.reason;
            if (err instanceof AfriRateError && err.isRateLimited) throttled = err;
            errors.push({ target: direction, reason: describe(err) });
            continue;
          }
          found.push(...quotesFor(outcome.value.data.rates, b, q, null));
        }
      }

      const quotes = dedupe(found);

      if (quotes.length === 0) {
        const where = countries ? ` in ${countries.join(', ').toUpperCase()}` : '';
        if (throttled) {
          return errorResult(
            `Could not compare ${b}/${q}${where}: ${throttled.message}. ` +
              'This is a rate limit, not an answer — the quotes may well exist. Retry shortly.',
          );
        }
        if (errors.length > 0) {
          return errorResult(
            `Could not compare ${b}/${q}${where}. ` +
              errors.map((e) => `${e.target}: ${e.reason}`).join('; ') +
              '. Nothing is implied about whether the rate exists.',
          );
        }
        return errorResult(
          `Nobody publishes ${b}/${q}${where}. Try convert, which can cross through USD.`,
        );
      }

      const sorted = [...quotes].sort((x, y) => x.rate - y.rate);
      const best = sorted[0]!;
      const worst = sorted[sorted.length - 1]!;
      const singleSource = sorted.length === 1;
      // More quote currency per unit of base is worse for someone selling base,
      // so "best" here means the lowest quote. Spelled out in the text.
      const spread = singleSource || best.rate <= 0 ? null : ((worst.rate - best.rate) / best.rate) * 100;

      const lines = sorted.map((row) => {
        const where = row.country ? `${row.country} ` : '';
        const flags = [row.stale ? '⚠ stale' : null, row.inverted ? 'inverted' : null].filter(Boolean).join(', ');
        return (
          `• ${where}${row.source}: ${row.rate.toPrecision(8)} — ${row.rate_date}${ageNote(row.rate_date)}` +
          `${flags ? ` (${flags})` : ''}`
        );
      });

      const at = (row: Quote): string => `${row.source}${row.country ? ` (${row.country})` : ''}`;
      const summary = singleSource
        ? `\nOnly ${at(best)} publishes ${b}/${q}, so there is no cross-source comparison to make here — ` +
          'this is a single quote, not a spread of zero.'
        : spread === null
          ? ''
          : `\nSpread across sources: ${spread.toFixed(2)}% — cheapest ${at(best)}, dearest ${at(worst)}.`;

      const missing = unavailable.length > 0 ? `\nNo ${b}/${q} quote published by: ${unavailable.join(', ')}.` : '';
      const unread =
        errors.length > 0
          ? `\n⚠ Could not check ${errors.map((e) => `${e.target} (${e.reason})`).join(', ')} — ` +
            'those may publish this pair; we did not find out.'
          : '';

      return textResult(
        [`${b}/${q} across ${sorted.length} quote${singleSource ? '' : 's'}:`, ...lines].join('\n') +
          summary +
          missing +
          unread,
        {
          base: b,
          quote: q,
          count: sorted.length,
          best: { country: best.country, source: best.source, rate: best.rate },
          worst: { country: worst.country, source: worst.source, rate: worst.rate },
          spread_pct: spread,
          single_source: singleSource,
          quotes: sorted,
          unavailable,
          errors,
        },
      );
    },
  );
}
