import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AfriRateClient } from './afrirate.js';
import type { Config } from './config.js';
import { registerConvertTool } from './tools/convert.js';
import { registerCorridorTool } from './tools/corridor.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerLookupTools } from './tools/lookups.js';
import { registerRateTools } from './tools/rates.js';

export const SERVER_NAME = 'afrirate';
export const SERVER_VERSION = '0.1.0';

/**
 * A fresh server per request. The HTTP transport runs stateless, so nothing is
 * carried between calls and two judges hitting the endpoint at once cannot see
 * each other's traffic.
 */
export function createMcpServer(config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'AfriRate — African exchange rates' },
    {
      instructions:
        'AfriRate publishes exchange rates, inflation and central-bank gold prices for 28 African ' +
        'countries, scraped from central banks and market sources. Use list_countries to map a country ' +
        'name to its ISO code before calling anything else. Every rate carries a `stale` flag: when it is ' +
        'true, the source has been failing and the number is the last one published — say so rather than ' +
        'presenting it as current.',
    },
  );

  const client = new AfriRateClient(config);

  registerLookupTools(server, client);
  registerRateTools(server, client);
  registerIndicatorTools(server, client);
  registerConvertTool(server, client);
  registerCorridorTool(server, client);

  return server;
}
