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
  ) {
    super(message);
    this.name = 'AfriRateError';
  }
}

interface Envelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface Result<T> {
  data: T;
  meta: ApiMeta;
}

export class AfriRateClient {
  constructor(private readonly config: Config) {}

  private async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<Result<T>> {
    const url = new URL(this.config.apiBase + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

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

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
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
