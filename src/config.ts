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

  return {
    apiBase: (env.AFRIRATE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    apiKey: env.AFRIRATE_MCP_API_KEY || undefined,
    port,
    host: env.HOST ?? '127.0.0.1',
    requestTimeoutMs: timeout,
  };
}
