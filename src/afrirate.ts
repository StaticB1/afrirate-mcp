import { ResponseCache } from './cache.js';
import type { Config } from './config.js';

/** Every AfriRate v1 response is wrapped in this envelope. */
export interface ApiMeta {
  timestamp: string;
  last_updated?: string;
  count?: number;
}

export interface Country {
  code: string;
  name: string;
  slug: string;
  timezone: string;
  sources: number;
}

export interface Currency {
  code: string;
  name: string;
  symbol: string | null;
  decimals: number;
}

/**
 * `stale` is AfriRate's honesty flag: true when the source feeding this rate
 * has been failing, so the value is the last one published rather than a fresh
 * scrape. Every tool that returns a rate carries it through — an agent that
 * quotes a dead central bank without saying so is worse than one that declines.
 */
export interface Rate {
  source: string;
  base: string;
  quote: string;
  rate: string;
  bid: string | null;
  ask: string | null;
  rate_date: string;
  updated_at: string;
  stale: boolean;
}

export interface Inflation {
  source: string;
  denomination: string | null;
  period_date: string;
  mom: string | null;
  yoy: string | null;
  cpi_index: string | null;
  food_yoy: string | null;
  food_mom: string | null;
  nonfood_yoy: string | null;
  nonfood_mom: string | null;
  updated_at: string;
}

export interface Gold {
  source: string;
  priced_in: string;
  product: string;
  selling_price: string;
  prev_pm_fix: string | null;
  price_date: string;
  updated_at: string;
}

export class AfriRateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Seconds until the quota window reopens. Only set for `rate_limited`. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AfriRateError';
  }

  /** True when the answer is unknown because we were throttled — not because no data exists. */
  get isRateLimited(): boolean {
    return this.code === 'rate_limited';
  }
}

/**
 * What upstream last told us about our own quota. Read from every response,
 * including errors — a 429 is the most informative one.
 */
export interface Quota {
  limit: number | null;
  remaining: number | null;
  /** ISO timestamp when the window resets. */
  resetAt: string | null;
  observedAt: string;
}

interface Envelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface Result<T> {
  data: T;
  meta: ApiMeta;
}

/**
 * Lookups change when a country is added, which is a deploy, not a minute.
 * Inflation is monthly and gold is daily. Rates follow the TTL from config,
 * which defaults to the 60s upstream already advertises via `s-maxage`.
 */
const LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const INDICATOR_TTL_MS = 10 * 60 * 1000;
// /healthz probes upstream, and that probe spends a request out of ten per
// minute. A minute of cache caps anything polling it at 10% of the budget
// rather than letting a monitor quietly eat the judging window.
const HEALTH_TTL_MS = 60 * 1000;

export class AfriRateClient {
  private lastQuota: Quota | null = null;

  constructor(
    private readonly config: Config,
    /**
     * Shared deliberately: one cache for the whole process, not one per MCP
     * request, or nothing is ever a hit. See cache.ts for why that is safe.
     */
    private readonly cache: ResponseCache = new ResponseCache(),
  ) {}

  /** The last quota figures upstream reported, or null if we have not spent a request yet. */
  quota(): Quota | null {
    return this.lastQuota;
  }

  cacheStats() {
    return this.cache.stats();
  }

  private ttlFor(path: string): number {
    switch (path) {
      case '/countries':
      case '/currencies':
        return LOOKUP_TTL_MS;
      case '/inflation/latest':
      case '/gold/latest':
        return INDICATOR_TTL_MS;
      case '/health':
        return HEALTH_TTL_MS;
      default:
        return this.config.rateTtlMs;
    }
  }

  private recordQuota(response: Response): void {
    const num = (name: string): number | null => {
      const raw = response.headers.get(name);
      if (raw === null || raw.trim() === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const limit = num('x-ratelimit-limit');
    const remaining = num('x-ratelimit-remaining');
    const reset = num('x-ratelimit-reset');
    if (limit === null && remaining === null && reset === null) return;
    this.lastQuota = {
      limit,
      remaining,
      // Unix seconds upstream, ISO here: an agent reading this should not have to do epoch maths.
      resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
      observedAt: new Date().toISOString(),
    };
  }

  private get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<Result<T>> {
    const url = new URL(this.config.apiBase + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    return this.cache.fetch(url.toString(), this.ttlFor(path), () => this.request<T>(url));
  }

  private async request<T>(url: URL): Promise<Result<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new AfriRateError(`AfriRate API unreachable: ${reason}`, 503, 'upstream_unreachable');
    }

    this.recordQuota(response);

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;

      // A 429 is not "no data". Every caller above must be able to tell the
      // difference, because reporting a throttle as an absent quote is a wrong
      // answer rather than an error.
      if (response.status === 429) {
        const retryHeader = Number(response.headers.get('retry-after'));
        const fromReset = this.lastQuota?.resetAt
          ? Math.max(0, Math.ceil((Date.parse(this.lastQuota.resetAt) - Date.now()) / 1000))
          : undefined;
        const retryAfterSec = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : fromReset;
        const limit = this.lastQuota?.limit;
        throw new AfriRateError(
          `AfriRate rate limit reached${limit ? ` (${limit} requests/minute)` : ''}` +
            `${retryAfterSec === undefined ? '' : `, retry in ${retryAfterSec}s`}`,
          429,
          'rate_limited',
          retryAfterSec,
        );
      }

      // 401 here means our own key is missing or wrong, not the caller's fault.
      // Say which, because "unauthorized" sent to an agent is unactionable.
      const hint =
        response.status === 401 && !this.config.apiKey
          ? 'this server has no AFRIRATE_MCP_API_KEY configured'
          : (error?.message ?? response.statusText);
      throw new AfriRateError(hint, response.status, error?.code ?? 'upstream_error');
    }

    const envelope = body as Envelope<T> | undefined;
    if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
      throw new AfriRateError('AfriRate API returned an unrecognised body', 502, 'bad_envelope');
    }
    return { data: envelope.data, meta: envelope.meta };
  }

  countries(): Promise<Result<{ countries: Country[] }>> {
    return this.get('/countries');
  }

  currencies(): Promise<Result<{ currencies: Currency[] }>> {
    return this.get('/currencies');
  }

  /** Either `country`, or both `base` and `quote`. The API rejects anything else with a 400. */
  rates(params: { country?: string; base?: string; quote?: string }): Promise<Result<{ country: string | null; rates: Rate[] }>> {
    return this.get('/rates/latest', params);
  }

  inflation(country: string): Promise<Result<{ country: string; inflation: Inflation[] }>> {
    return this.get('/inflation/latest', { country });
  }

  gold(country: string): Promise<Result<{ country: string; gold: Gold[] }>> {
    return this.get('/gold/latest', { country });
  }

  health(): Promise<Result<{ status: string; db: string }>> {
    return this.get('/health');
  }
}
