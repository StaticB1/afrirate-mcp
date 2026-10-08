import type { Rate } from './afrirate.js';

/** Rates arrive as strings from Postgres numerics. Parse without losing the original. */
export function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatAmount(value: number, currency: string): string {
  const decimals = Math.abs(value) >= 1000 ? 2 : 4;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: decimals })} ${currency}`;
}

/**
 * Pick the row an agent should quote: never a stale source when a live one
 * exists, then the most recent observation.
 */
export function bestRate(rows: Rate[]): Rate | undefined {
  return [...rows].sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    if (a.rate_date !== b.rate_date) return a.rate_date < b.rate_date ? 1 : -1;
    return a.updated_at < b.updated_at ? 1 : -1;
  })[0];
}

/** Whole days between an observation date (YYYY-MM-DD) and now. Null if unparseable. */
export function ageDays(rateDate: string, now: Date = new Date()): number | null {
  const then = Date.parse(`${rateDate}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  return days < 0 ? 0 : days;
}

/**
 * How old the observation is, said out loud once it stops being current.
 *
 * `stale` is not this. `stale` tracks whether the scraper is failing; a source
 * that publishes successfully but has not moved its numbers in three weeks
 * comes back `stale: false` with a three-week-old `rate_date`. Zimbabwe's RBZ
 * rows are exactly that today, so age has to be shown separately or we present
 * last month's rate as this morning's.
 */
const AGE_NOTE_AFTER_DAYS = 7;

export function ageNote(rateDate: string, now?: Date): string {
  const days = ageDays(rateDate, now);
  if (days === null || days < AGE_NOTE_AFTER_DAYS) return '';
  return ` ⏳ ${days} days old`;
}

/** One line per source, so the text half of the response is readable on its own. */
export function rateLine(row: Rate, now?: Date): string {
  const spread =
    row.bid && row.ask ? ` (bid ${row.bid} / ask ${row.ask})` : '';
  const stale = row.stale ? '  ⚠ STALE — source has been failing, this is the last published value' : '';
  return `• ${row.source}: 1 ${row.base} = ${row.rate} ${row.quote}${spread} — ${row.rate_date}${ageNote(row.rate_date, now)}${stale}`;
}

export function textResult(text: string, structured: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured,
  };
}

export function errorResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}
