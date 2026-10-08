import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AfriRateClient } from './afrirate.js';
import type { Config } from './config.js';
import { registerConvertTool } from './tools/convert.js';
import { registerCorridorTool } from './tools/corridor.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerLookupTools } from './tools/lookups.js';
import { registerRateTools } from './tools/rates.js';
import { registerWatchTools } from './tools/watch.js';
import type { WatchStore } from './watches.js';

export const SERVER_NAME = 'afrirate';
export const SERVER_VERSION = '0.1.0';

/**
 * A fresh server per request. The HTTP transport runs stateless, so nothing is
 * carried between calls and two judges hitting the endpoint at once cannot see
 * each other's traffic.
 *
 * The client is passed in rather than built here, and is deliberately shared
 * across requests: it holds the response cache, and a cache minted per request
 * can never record a hit. It holds no caller state — only our own API key and
 * public upstream responses.
 *
 * The watch store is shared for the same reason, and is the only caller state
 * the server holds: watchlists, keyed by ids the callers keep.
 */
export function createMcpServer(config: Config, client: AfriRateClient, store: WatchStore): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'AfriRate — African exchange rates' },
    {
      instructions:
        'AfriRate publishes exchange rates, inflation and central-bank gold prices for 28 African ' +
        'countries, scraped from central banks and market sources. Use list_countries to map a country ' +
        'name to its ISO code, and list_currencies to map a currency name to its code (Zimbabwe Gold is ZWG), ' +
        'before calling anything else. Every rate carries a `stale` flag: when it is ' +
        'true, the source has been failing and the number is the last one published — say so rather than ' +
        'presenting it as current. When the user wants to be told about a rate later, use watch_rate and ' +
        'give them the watchlist id it returns; it outlives this conversation. When the user has a watchlist ' +
        'id, call check_watches first and lead with anything that fired.',
    },
  );

  registerLookupTools(server, client);
  registerRateTools(server, client);
  registerIndicatorTools(server, client);
  registerConvertTool(server, client);
  registerCorridorTool(server, client);
  registerWatchTools(server, client, store);

  return server;
}
