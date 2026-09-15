import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient, Rate } from '../afrirate.js';
import { errorResult, textResult, toNumber } from '../format.js';

interface Quote {
  country: string | null;
  source: string;
  rate: number;
  rate_date: string;
  stale: boolean;
  inverted: boolean;
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

export function registerCorridorTool(server: McpServer, client: AfriRateClient): void {
  server.registerTool(
    'compare_corridor',
    {
      title: 'Compare one pair across sources and countries',
      description:
        'Compare the same currency pair across every source that publishes it, and optionally across ' +
        'several countries at once, then report the best and worst quote and the spread between them. ' +
        'This is what 28-country coverage is actually for: answering "where is this corridor cheapest" ' +
        'in one call instead of twenty.',
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
        spread_pct: z.number().nullable(),
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
        unavailable: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ base, quote, countries }) => {
      const b = base.toUpperCase();
      const q = quote.toUpperCase();
      if (b === q) return errorResult(`${b} and ${q} are the same currency.`);

      const quotes: Quote[] = [];
      const unavailable: string[] = [];

      if (countries && countries.length > 0) {
        // One country failing must not take the whole comparison down — name it
        // in `unavailable` and report the rest.
        const codes = countries.map((c) => c.toUpperCase());
        const settled = await Promise.allSettled(codes.map((code) => client.rates({ country: code })));
        settled.forEach((outcome, i) => {
          const code = codes[i]!;
          if (outcome.status === 'rejected') {
            unavailable.push(code);
            return;
          }
          const found = quotesFor(outcome.value.data.rates, b, q, code);
          if (found.length === 0) unavailable.push(code);
          quotes.push(...found);
        });
      } else {
        const { data } = await client.rates({ base: b, quote: q });
        quotes.push(...quotesFor(data.rates, b, q, null));
        if (quotes.length === 0) {
          const { data: reverse } = await client.rates({ base: q, quote: b });
          quotes.push(...quotesFor(reverse.rates, b, q, null));
        }
      }

      if (quotes.length === 0) {
        return errorResult(
          `Nobody publishes ${b}/${q}${countries ? ` in ${countries.join(', ').toUpperCase()}` : ''}. ` +
            'Try convert, which can cross through USD.',
        );
      }

      const sorted = [...quotes].sort((x, y) => x.rate - y.rate);
      const best = sorted[0]!;
      const worst = sorted[sorted.length - 1]!;
      // More quote currency per unit of base is worse for someone selling base,
      // so "best" here means the lowest quote. Spelled out in the text.
      const spread = best.rate > 0 ? ((worst.rate - best.rate) / best.rate) * 100 : null;

      const lines = sorted.map((row) => {
        const where = row.country ? `${row.country} ` : '';
        const flags = [row.stale ? '⚠ stale' : null, row.inverted ? 'inverted' : null].filter(Boolean).join(', ');
        return `• ${where}${row.source}: ${row.rate.toPrecision(8)} — ${row.rate_date}${flags ? ` (${flags})` : ''}`;
      });

      const summary =
        spread === null
          ? ''
          : `\nSpread across sources: ${spread.toFixed(2)}% — cheapest ${best.source}` +
            `${best.country ? ` (${best.country})` : ''}, dearest ${worst.source}${worst.country ? ` (${worst.country})` : ''}.`;
      const missing = unavailable.length > 0 ? `\nNo ${b}/${q} quote from: ${unavailable.join(', ')}.` : '';

      return textResult(
        [`${b}/${q} across ${quotes.length} quote${quotes.length === 1 ? '' : 's'}:`, ...lines].join('\n') +
          summary +
          missing,
        {
          base: b,
          quote: q,
          count: quotes.length,
          best: { country: best.country, source: best.source, rate: best.rate },
          worst: { country: worst.country, source: worst.source, rate: worst.rate },
          spread_pct: spread,
          quotes: sorted,
          unavailable,
        },
      );
    },
  );
}
