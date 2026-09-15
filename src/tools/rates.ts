import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient } from '../afrirate.js';
import { errorResult, rateLine, textResult } from '../format.js';

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

      const { data, meta } = await client.rates({
        country: country?.toUpperCase(),
        base: base?.toUpperCase(),
        quote: quote?.toUpperCase(),
      });

      if (data.rates.length === 0) {
        const asked = country ? `country ${country.toUpperCase()}` : `${base?.toUpperCase()}/${quote?.toUpperCase()}`;
        return errorResult(`No rates published for ${asked}. Use list_countries to see what is covered.`);
      }

      const staleCount = data.rates.filter((r) => r.stale).length;
      const header = country
        ? `Latest rates for ${country.toUpperCase()} (${data.rates.length} pairs):`
        : `${base?.toUpperCase()}/${quote?.toUpperCase()} across ${data.rates.length} source${data.rates.length === 1 ? '' : 's'}:`;
      const footer = staleCount > 0 ? `\n\n${staleCount} of these come from a source that is currently failing.` : '';

      return textResult([header, ...data.rates.map(rateLine)].join('\n') + footer, {
        country: data.country,
        count: data.rates.length,
        last_updated: meta.last_updated,
        rates: data.rates,
      });
    },
  );
}
