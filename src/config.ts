/**
 * Configuration, read once at boot and validated loudly.
 *
 * The API key is the one credential this service holds. It is read from the
 * environment and never echoed into a response, a log line or the repo — the
 * whole point of hosting the MCP server ourselves is that a judge never has to
 * handle a credential.
 */
export interface Config {
  /** AfriRate REST base, including the /api/v1 prefix. */
  apiBase: string;
  /** Unlimited-tier key minted in AfriRate admin. Absent = only the free endpoints work. */
  apiKey?: string;
  port: number;
  host: string;
  requestTimeoutMs: number;
  /**
   * How long a rate response may be reused. Upstream already advertises
   * `cache-control: s-maxage=60` on these, so 60s is its own contract, not a
   * guess of ours. Set to 0 to disable caching of rates.
   */
  rateTtlMs: number;
  /**
   * Where watchlists are kept. systemd's StateDirectory= sets STATE_DIRECTORY,
   * so the unit only has to declare one; locally it falls back to ./data.
   */
  stateDir: string;
}

const DEFAULT_API_BASE = 'https://afrirate.statotec.com/api/v1';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3025);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got '${env.PORT}'`);
  }

  const timeout = Number(env.AFRIRATE_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`AFRIRATE_TIMEOUT_MS must be a positive number, got '${env.AFRIRATE_TIMEOUT_MS}'`);
  }

  const rateTtl = Number(env.AFRIRATE_CACHE_TTL_MS ?? 60_000);
  if (!Number.isFinite(rateTtl) || rateTtl < 0) {
    throw new Error(`AFRIRATE_CACHE_TTL_MS must be zero or a positive number, got '${env.AFRIRATE_CACHE_TTL_MS}'`);
  }

  return {
    apiBase: (env.AFRIRATE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    apiKey: env.AFRIRATE_MCP_API_KEY || undefined,
    port,
    host: env.HOST ?? '127.0.0.1',
    requestTimeoutMs: timeout,
    rateTtlMs: rateTtl,
    stateDir: env.AFRIRATE_STATE_DIR || env.STATE_DIRECTORY || './data',
  };
}
