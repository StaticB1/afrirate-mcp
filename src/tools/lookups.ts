import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient } from '../afrirate.js';
import { textResult } from '../format.js';

export function registerLookupTools(server: McpServer, client: AfriRateClient): void {
  server.registerTool(
    'list_countries',
    {
      title: 'List covered countries',
      description:
        'List every African country AfriRate covers, with its ISO code and how many rate sources feed it. ' +
        'Call this first when the user names a country in prose and you need its code.',
      inputSchema: {},
      outputSchema: {
        count: z.number().describe('Number of countries covered'),
        countries: z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            timezone: z.string(),
            sources: z.number(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { data } = await client.countries();
      const countries = data.countries.map(({ code, name, timezone, sources }) => ({
        code,
        name,
        timezone,
        sources,
      }));
      const text = [
        `AfriRate covers ${countries.length} countries:`,
        ...countries.map((c) => `• ${c.code} — ${c.name} (${c.sources} source${c.sources === 1 ? '' : 's'})`),
      ].join('\n');
      return textResult(text, { count: countries.length, countries });
    },
  );

  server.registerTool(
    'list_currencies',
    {
      title: 'List known currencies',
      description: 'List every currency AfriRate quotes, with its symbol and decimal precision.',
      inputSchema: {},
      outputSchema: {
        count: z.number(),
        currencies: z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            symbol: z.string().nullable(),
            decimals: z.number(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { data } = await client.currencies();
      const text = [
        `${data.currencies.length} currencies:`,
        ...data.currencies.map((c) => `• ${c.code} — ${c.name}${c.symbol ? ` (${c.symbol})` : ''}`),
      ].join('\n');
      return textResult(text, { count: data.currencies.length, currencies: data.currencies });
    },
  );
}
