import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient } from '../afrirate.js';
import { ageDays, ageNote, errorResult, formatAmount, textResult } from '../format.js';
import { resolveRoute, unknownCurrencyHint } from '../route.js';

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
        source: z
          .string()
          .optional()
          .describe('Restrict to one source by its code as get_rate shows it, e.g. rbz or cbk. Usually leave this out.'),
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

      const route = await resolveRoute(client, base, quote, { country: country?.toUpperCase(), source });
      if (!route && source) {
        // The restriction may be what failed, not the pair. Saying "no route"
        // when a route exists through another source sends the agent away
        // from an answer it could have had.
        const any = await resolveRoute(client, base, quote, { country: country?.toUpperCase() });
        if (any) {
          return errorResult(
            `No source matching "${source}" publishes ${base}/${quote}. It is published by ` +
              `${[...new Set(any.sources)].join(', ')} — pass that as source, or leave source out.`,
          );
        }
      }
      if (!route) {
        const hint = await unknownCurrencyHint(client, [base, quote]);
        if (hint) return errorResult(hint);
        return errorResult(
          `No published route from ${base} to ${quote}${country ? ` via ${country.toUpperCase()} sources` : ''}. ` +
            'Try get_rate to see which pairs exist.',
        );
      }
      const { legs, path, rate, stale, sources, asOf } = route;
      const result = amount * rate;

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
