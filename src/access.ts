/**
 * Who may spend what on the hosted server.
 *
 * The server's own key is a high-volume one, so without a limit here every
 * keyless caller would get more than AfriRate's paid plans sell. Keyless
 * callers therefore get the Free plan's volume per IP. A caller who sends their
 * own AfriRate key is served on that key instead: their plan's limits apply,
 * and AfriRate meters the usage against their account.
 */

const KEY_RE = /^ar_[0-9a-f]{32}$/;

/**
 * The caller's own AfriRate key: `Authorization: Bearer ar_…`, or `?api_key=ar_…`
 * on the URL for clients that cannot set headers (claude.ai and ChatGPT
 * connectors), the same two forms the AfriRate REST API accepts. The header wins.
 */
export function callerKey(authorization: string | undefined, query?: URLSearchParams): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '');
  if (m && KEY_RE.test(m[1]!)) return m[1];
  const fromQuery = query?.get('api_key')?.trim();
  return fromQuery && KEY_RE.test(fromQuery) ? fromQuery : undefined;
}

/**
 * Tool calls in one JSON-RPC message or batch. Only these cost anything:
 * initialize, tools/list and resource reads are what every client sends before
 * it can ask a question, and counting them would spend the allowance on setup.
 */
export function countToolCalls(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter(
    (m) => typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call',
  ).length;
}

export interface Allowance {
  perMinute: number;
  perDay: number;
}

export type Verdict = { ok: true } | { ok: false; window: 'minute' | 'day'; retryAfterSec: number };

/**
 * Per-IP counters for keyless callers: a one-minute window from the first call,
 * and a UTC day, matching how AfriRate resets its own daily limit. In memory, so
 * a restart forgives everyone, which is acceptable for a free allowance.
 */
export class FreeAllowance {
  private readonly minute = new Map<string, { start: number; used: number }>();
  private readonly day = new Map<string, { date: string; used: number }>();

  constructor(
    readonly limits: Allowance,
    private readonly now: () => number = Date.now,
  ) {}

  /** Spend `n` calls for `ip`, all or nothing. */
  take(ip: string, n: number): Verdict {
    if (n <= 0) return { ok: true };
    const t = this.now();
    const date = new Date(t).toISOString().slice(0, 10);

    const m = this.minute.get(ip);
    const minute = m && t - m.start < 60_000 ? m : { start: t, used: 0 };
    const d = this.day.get(ip);
    const day = d && d.date === date ? d : { date, used: 0 };

    if (day.used + n > this.limits.perDay) {
      const midnight = Date.parse(`${date}T00:00:00Z`) + 86_400_000;
      return { ok: false, window: 'day', retryAfterSec: Math.ceil((midnight - t) / 1000) };
    }
    if (minute.used + n > this.limits.perMinute) {
      return { ok: false, window: 'minute', retryAfterSec: Math.ceil((minute.start + 60_000 - t) / 1000) };
    }

    minute.used += n;
    day.used += n;
    this.minute.set(ip, minute);
    this.day.set(ip, day);
    if (this.minute.size > 10_000) this.prune(t, date);
    return { ok: true };
  }

  private prune(t: number, date: string): void {
    for (const [ip, w] of this.minute) if (t - w.start >= 60_000) this.minute.delete(ip);
    for (const [ip, w] of this.day) if (w.date !== date) this.day.delete(ip);
  }
}

/** What a keyless caller is told when keyless access is off (AFRIRATE_MCP_KEYLESS=off). */
export function keyRequiredMessage(): string {
  return (
    'This server needs an AfriRate API key. Get one at https://afrirate.statotec.com/signup ' +
    '(the Free plan costs nothing), then connect with https://mcp.afrirate.statotec.com/mcp/<key>, ' +
    'add ?api_key=<key> to the address, or send "Authorization: Bearer <key>".'
  );
}

/** What a keyless caller is told when the allowance runs out: how to get more. */
export function limitMessage(limits: Allowance, verdict: Extract<Verdict, { ok: false }>): string {
  const which =
    verdict.window === 'day'
      ? `${limits.perDay} tool calls a day`
      : `${limits.perMinute} tool calls a minute`;
  return (
    `The free allowance for keyless use of this server is used up (${which}); it resets in ` +
    `${verdict.retryAfterSec}s. For more, get an AfriRate API key at https://afrirate.statotec.com/pricing ` +
    `(the Free plan costs nothing) and send it as "Authorization: Bearer <key>". Your plan's limits then apply.`
  );
}
