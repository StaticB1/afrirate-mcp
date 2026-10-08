import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient } from '../afrirate.js';
import { errorResult, rateLine, textResult } from '../format.js';
import { unknownCurrencyHint } from '../route.js';

const rateShape = z.object({
  source: z.string(),
  base: z.string(),
  quote: z.string(),
  rate: z.string(),
  bid: z.string().nullable(),
  ask: z.string().nullable(),
  rate_date: z.string(),
  updated_at: z.string(),
  stale: z.boolean(),
});

export function registerRateTools(server: McpServer, client: AfriRateClient): void {
  server.registerTool(
    'get_rate',
    {
      title: 'Latest exchange rates',
      description:
        'Latest exchange rates, either every pair for one country (country="ZW") or one pair across every ' +
        'source that publishes it (base="USD", quote="KES"). Each row carries a `stale` flag — when it is ' +
        'true the source has been failing and the value is the last one published, so say so when you quote it.',
      inputSchema: {
        country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code, e.g. ZW'),
        base: z.string().min(3).max(3).optional().describe('Base currency code, e.g. USD'),
        quote: z.string().min(3).max(3).optional().describe('Quote currency code, e.g. ZWG'),
      },
      outputSchema: {
        country: z.string().nullable(),
        count: z.number(),
        last_updated: z.string().optional(),
        rates: z.array(rateShape),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ country, base, quote }) => {
      if (!country && !(base && quote)) {
        return errorResult('Provide either a country code, or both base and quote currency codes.');
      }

      const { data: all, meta } = await client.rates({
        country: country?.toUpperCase(),
        base: base?.toUpperCase(),
        quote: quote?.toUpperCase(),
      });
      // The country form returns every pair the country publishes and ignores
      // base/quote. When both were given the caller wants the one pair.
      const b = base?.toUpperCase();
      const q = quote?.toUpperCase();
      const narrowed =
        country && (b || q) ? all.rates.filter((r) => (!b || r.base === b) && (!q || r.quote === q)) : all.rates;
      // Asked for a pair the country does not publish — often a guessed code,
      // ZWL for Zimbabwe's retired dollar rather than ZWG — answer with what it
      // does publish instead of an empty error the model has to recover from.
      const missedPair = country !== undefined && (b !== undefined || q !== undefined) && narrowed.length === 0;
      const data = { ...all, rates: missedPair ? all.rates : narrowed };

      if (data.rates.length === 0) {
        const asked = country
          ? `country ${country.toUpperCase()}${b || q ? ` (${b ?? '*'}/${q ?? '*'})` : ''}`
          : `${b}/${q}`;
        return errorResult(`No rates published for ${asked}. Use list_countries to see what is covered.`);
      }

      const staleCount = data.rates.filter((r) => r.stale).length;
      const note = missedPair
        ? `${country!.toUpperCase()} publishes no ${b ?? '*'}/${q ?? '*'} rate. ` +
          `${(await unknownCurrencyHint(client, [b, q].filter((c): c is string => c !== undefined))) ?? ''}`.trim() +
          ' Everything it does publish:\n'
        : '';
      const header = country
        ? `${note}Latest rates for ${country.toUpperCase()} (${data.rates.length} pair${data.rates.length === 1 ? '' : 's'}):`
        : `${base?.toUpperCase()}/${quote?.toUpperCase()} across ${data.rates.length} source${data.rates.length === 1 ? '' : 's'}:`;
      const footer = staleCount > 0 ? `\n\n${staleCount} of these come from a source that is currently failing.` : '';

      return textResult([header, ...data.rates.map((row) => rateLine(row))].join('\n') + footer, {
        country: data.country,
        count: data.rates.length,
        last_updated: meta.last_updated,
        rates: data.rates,
      });
    },
  );
}
