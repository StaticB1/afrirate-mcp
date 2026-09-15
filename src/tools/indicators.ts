import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient } from '../afrirate.js';
import { errorResult, textResult } from '../format.js';

export function registerIndicatorTools(server: McpServer, client: AfriRateClient): void {
  server.registerTool(
    'get_inflation',
    {
      title: 'Latest inflation figures',
      description:
        'Latest published inflation for a country: month-on-month, year-on-year and the CPI index, split ' +
        'into food and non-food where the statistics agency publishes it. Zimbabwe publishes separate USD ' +
        'and ZWG series, which arrive as separate rows distinguished by `denomination`.',
      inputSchema: {
        country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. ZW'),
      },
      outputSchema: {
        country: z.string(),
        count: z.number(),
        inflation: z.array(
          z.object({
            source: z.string(),
            denomination: z.string().nullable(),
            period_date: z.string(),
            mom: z.string().nullable(),
            yoy: z.string().nullable(),
            cpi_index: z.string().nullable(),
            food_yoy: z.string().nullable(),
            food_mom: z.string().nullable(),
            nonfood_yoy: z.string().nullable(),
            nonfood_mom: z.string().nullable(),
            updated_at: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ country }) => {
      const code = country.toUpperCase();
      const { data } = await client.inflation(code);
      if (data.inflation.length === 0) {
        return errorResult(`No inflation series published for ${code}.`);
      }
      const lines = data.inflation.map((row) => {
        const label = row.denomination ? `${row.source} (${row.denomination})` : row.source;
        const parts = [
          row.yoy !== null ? `YoY ${row.yoy}%` : null,
          row.mom !== null ? `MoM ${row.mom}%` : null,
          row.cpi_index !== null ? `CPI ${row.cpi_index}` : null,
        ].filter(Boolean);
        return `• ${label}, ${row.period_date}: ${parts.join(', ') || 'no figures'}`;
      });
      return textResult([`Inflation for ${code}:`, ...lines].join('\n'), {
        country: data.country,
        count: data.inflation.length,
        inflation: data.inflation,
      });
    },
  );

  server.registerTool(
    'get_gold',
    {
      title: 'Latest gold-coin prices',
      description:
        'Latest central-bank gold-coin prices for a country — Zimbabwe’s Mosi-oa-Tunya coin is the main ' +
        'series. Useful as a store-of-value reference where the local currency is unstable.',
      inputSchema: {
        country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. ZW'),
      },
      outputSchema: {
        country: z.string(),
        count: z.number(),
        gold: z.array(
          z.object({
            source: z.string(),
            priced_in: z.string(),
            product: z.string(),
            selling_price: z.string(),
            prev_pm_fix: z.string().nullable(),
            price_date: z.string(),
            updated_at: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ country }) => {
      const code = country.toUpperCase();
      const { data } = await client.gold(code);
      if (data.gold.length === 0) {
        return errorResult(`No gold-coin prices published for ${code}.`);
      }
      const lines = data.gold.map(
        (row) => `• ${row.product} (${row.source}): ${row.selling_price} ${row.priced_in} — ${row.price_date}`,
      );
      return textResult([`Gold prices for ${code}:`, ...lines].join('\n'), {
        country: data.country,
        count: data.gold.length,
        gold: data.gold,
      });
    },
  );
}
