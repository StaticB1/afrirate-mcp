import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient, Rate } from '../afrirate.js';
import { ageDays, ageNote, bestRate, errorResult, formatAmount, textResult, toNumber } from '../format.js';

/** One hop in a conversion: the row we used, and whether we read it backwards. */
interface Leg {
  row: Rate;
  inverted: boolean;
  factor: number;
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

function pick(rows: Rate[], source?: string): Rate | undefined {
  const filtered = source ? rows.filter((r) => r.source.toLowerCase() === source.toLowerCase()) : rows;
  return bestRate(filtered);
}

/** Direct, then inverse. Returns undefined rather than throwing so the caller can try a cross. */
async function resolveDirect(
  client: AfriRateClient,
  from: string,
  to: string,
  opts: { country?: string; source?: string },
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

export function registerConvertTool(server: McpServer, client: AfriRateClient): void {
  server.registerTool(
    'convert',
    {
      title: 'Convert an amount between currencies',
      description:
        'Convert an amount between two currencies using published African rates. Tries the direct pair, ' +
        'then the inverse, then a cross through USD, and tells you which path it used and which source it ' +
        'trusted. No AfriRate endpoint does this — it is computed here. Passing `country` when you know it ' +
        'costs one upstream request instead of up to six, which matters against a 10-per-minute budget.',
      inputSchema: {
        amount: z.number().positive().describe('Amount to convert'),
        from: z.string().min(3).max(3).describe('Currency to convert from, e.g. USD'),
        to: z.string().min(3).max(3).describe('Currency to convert to, e.g. ZWG'),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('Restrict to sources from this country, e.g. ZW for the RBZ official rate'),
        source: z.string().optional().describe('Restrict to one named source, e.g. RBZ'),
      },
      outputSchema: {
        amount: z.number(),
        from: z.string(),
        to: z.string(),
        result: z.number(),
        rate: z.number(),
        path: z.enum(['direct', 'inverse', 'cross-usd']),
        stale: z.boolean(),
        sources: z.array(z.string()),
        as_of: z.string(),
        /** Days since the oldest leg was observed. `stale` is scraper health; this is data age. */
        age_days: z.number().nullable(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ amount, from, to, country, source }) => {
      const base = from.toUpperCase();
      const quote = to.toUpperCase();

      if (base === quote) {
        return errorResult(`${base} and ${quote} are the same currency — nothing to convert.`);
      }

      const opts = { country: country?.toUpperCase(), source };
      const legs: Leg[] = [];
      let path: 'direct' | 'inverse' | 'cross-usd';

      const oneHop = await resolveDirect(client, base, quote, opts);
      if (oneHop) {
        legs.push(oneHop);
        path = oneHop.inverted ? 'inverse' : 'direct';
      } else {
        // Nothing quotes this pair. Almost every African source quotes against
        // USD, so a cross through it is the difference between an answer and a
        // shrug.
        const first = await resolveDirect(client, base, 'USD', opts);
        const second = await resolveDirect(client, 'USD', quote, opts);
        if (!first || !second) {
          return errorResult(
            `No published route from ${base} to ${quote}${country ? ` via ${country.toUpperCase()} sources` : ''}. ` +
              'Try get_rate to see which pairs exist.',
          );
        }
        legs.push(first, second);
        path = 'cross-usd';
      }

      const rate = legs.reduce((acc, leg) => acc * leg.factor, 1);
      const result = amount * rate;
      const stale = legs.some((leg) => leg.row.stale);
      const sources = legs.map((leg) => leg.row.source);
      const asOf = legs.map((leg) => leg.row.rate_date).sort()[0]!;

      // Every leg shows its own observation date. A cross-USD route can pair a
      // rate from this morning with one from three weeks ago, and averaging
      // those into a single "as of" hides exactly the thing a user would want
      // to know before acting on the number.
      const detail = legs
        .map(
          (leg) =>
            `  ↳ ${leg.row.source}: 1 ${leg.row.base} = ${leg.row.rate} ${leg.row.quote}` +
            `${leg.inverted ? ', read inverted' : ''} — ${leg.row.rate_date}${ageNote(leg.row.rate_date)}`,
        )
        .join('\n');

      const age = ageDays(asOf);
      const staleWarning = stale
        ? '\n⚠ At least one source feeding this conversion is currently failing, so the figure is the last published value, not a fresh one.'
        : '';
      const ageWarning =
        age !== null && age >= 7
          ? `\n⚠ The oldest leg of this conversion was published ${age} days ago. The source is not flagged as failing, ` +
            'it simply has not moved its figure since — treat this as that day\'s rate, not today\'s.'
          : '';

      const text =
        `${formatAmount(amount, base)} = ${formatAmount(result, quote)}\n` +
        `Rate used: 1 ${base} = ${rate.toPrecision(8)} ${quote} (${path}, as of ${asOf})\n` +
        detail +
        staleWarning +
        ageWarning;

      return textResult(text, {
        amount,
        from: base,
        to: quote,
        result,
        rate,
        path,
        stale,
        sources,
        as_of: asOf,
        age_days: age,
      });
    },
  );
}
