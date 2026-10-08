import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AfriRateError, type AfriRateClient } from '../afrirate.js';
import { ageDays, ageNote, errorResult, textResult } from '../format.js';
import { resolveRoute, unknownCurrencyHint, type Route } from '../route.js';
import {
  MAX_WATCHES_PER_LIST,
  isListId,
  type Condition,
  type Observation,
  type Watch,
  type WatchStore,
} from '../watches.js';

const listIdSchema = z
  .string()
  .describe('Watchlist id from an earlier watch_rate, e.g. wl_k3x9p2m7qa. Holding the id is what grants access.');

function describe(err: unknown): string {
  if (err instanceof AfriRateError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function sayCondition(c: Condition, from: string, to: string): string {
  switch (c.kind) {
    case 'above':
      return `${from}/${to} goes above ${c.value}`;
    case 'below':
      return `${from}/${to} goes below ${c.value}`;
    case 'moves':
      return `${from}/${to} moves ${c.value}% or more either way`;
  }
}

function holds(c: Condition, rate: number, baseline: number): boolean {
  switch (c.kind) {
    case 'above':
      return rate > c.value;
    case 'below':
      return rate < c.value;
    case 'moves':
      return baseline > 0 && Math.abs((rate / baseline - 1) * 100) >= c.value;
  }
}

function pct(now: number, then: number): number {
  return then > 0 ? (now / then - 1) * 100 : 0;
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** "3 days ago", "5 hours ago", "just now" — how long since an ISO timestamp. */
function since(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function observe(route: Route, now: Date): Observation {
  return { rate: route.rate, as_of: route.asOf, at: now.toISOString() };
}

const watchShape = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  country: z.string().nullable(),
  condition: z.object({ kind: z.enum(['above', 'below', 'moves']), value: z.number() }),
});

export function registerWatchTools(server: McpServer, client: AfriRateClient, store: WatchStore): void {
  server.registerTool(
    'watch_rate',
    {
      title: 'Watch a rate across conversations',
      description:
        'Remember a rate the user cares about and a condition on it — above a level, below a level, or a ' +
        'move of some percent — so a later conversation can ask what changed. Returns a watchlist id: give ' +
        'it to the user and keep it, because check_watches needs it and it is the only key to the list. ' +
        'Pass an existing `watchlist` to add to it; omit it to start a new one. The rate is resolved the same ' +
        'way as convert (direct, inverse, cross through USD). There is no push notification: a watch fires ' +
        'when check_watches is called and finds the condition holds.',
      inputSchema: {
        from: z.string().min(3).max(3).describe('Base currency, e.g. USD'),
        to: z.string().min(3).max(3).describe('Quote currency, e.g. ZWG'),
        // One condition and one value, not three optional numbers: a model
        // filling a schema tends to send every optional number as 0, and
        // "above 0, below 0, moves 0%" is a different watch from the one asked for.
        condition: z
          .enum(['above', 'below', 'moves_pct'])
          .describe('above: fire when the rate rises above value. below: when it falls below value. ' +
            'moves_pct: when it moves at least value percent either way from today.'),
        value: z.number().positive().describe('The level (for above/below) or the percent (for moves_pct)'),
        country: z.string().length(2).optional().describe('Only use sources from this country, e.g. ZW'),
        watchlist: listIdSchema.optional(),
      },
      outputSchema: {
        watchlist: z.string(),
        watch: watchShape,
        rate: z.number(),
        as_of: z.string(),
        age_days: z.number().nullable(),
        already_holds: z.boolean(),
        watch_count: z.number(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ from, to, condition: kind, value, country, watchlist }) => {
      const base = from.toUpperCase();
      const quote = to.toUpperCase();
      if (base === quote) return errorResult(`${base} and ${quote} are the same currency — nothing to watch.`);

      if (kind === 'moves_pct' && value > 100) {
        return errorResult('moves_pct is a percentage; give a value of 100 or less.');
      }
      const condition: Condition = { kind: kind === 'moves_pct' ? 'moves' : kind, value };

      let list = watchlist ? await store.get(watchlist) : undefined;
      if (watchlist && !list) {
        return errorResult(
          `No watchlist ${watchlist}. ${isListId(watchlist) ? 'It may have expired after 90 days unused, or the id is mistyped.' : 'Watchlist ids look like wl_k3x9p2m7qa.'} ` +
            'Omit watchlist to start a new one.',
        );
      }
      if (list && list.watches.length >= MAX_WATCHES_PER_LIST) {
        return errorResult(
          `Watchlist ${list.id} already has ${MAX_WATCHES_PER_LIST} watches, the most one list can hold. ` +
            'Remove one with remove_watch first.',
        );
      }

      const cc = country?.toUpperCase();
      let route: Route | undefined;
      try {
        route = await resolveRoute(client, base, quote, { country: cc });
      } catch (err) {
        return errorResult(`Could not read ${base}/${quote} to set the watch: ${describe(err)}. Nothing was saved.`);
      }
      if (!route) {
        const hint = await unknownCurrencyHint(client, [base, quote]);
        if (hint) return errorResult(`${hint} Nothing was saved.`);
        return errorResult(
          `No published route from ${base} to ${quote}${cc ? ` via ${cc} sources` : ''}, so there is nothing to watch.`,
        );
      }

      const now = new Date();
      try {
        list ??= await store.create(now);
      } catch (err) {
        return errorResult(describe(err));
      }

      const reading = observe(route, now);
      const watch: Watch = {
        id: `w${list.next_watch++}`,
        from: base,
        to: quote,
        country: cc ?? null,
        condition,
        baseline: reading,
        last: reading,
        fired_at: null,
        held_when_set: holds(condition, route.rate, route.rate),
        created_at: now.toISOString(),
      };
      list.watches.push(watch);
      await store.save(list, now);

      const age = ageDays(route.asOf);
      const alreadyHolds = holds(condition, route.rate, route.rate);
      const lines = [
        `Watching: tell you when ${sayCondition(condition, base, quote)}.`,
        `Now: 1 ${base} = ${route.rate.toPrecision(8)} ${quote} (${route.sources.join(' → ')}, as of ${route.asOf}${ageNote(route.asOf)}).`,
        `Watchlist: ${list.id} — ${list.watches.length} watch${list.watches.length === 1 ? '' : 'es'}. ` +
          'Keep this id; check_watches needs it, and nothing else can find the list.',
      ];
      if (alreadyHolds) {
        lines.push(`Note: that condition already holds today, so the first check will report it as fired.`);
      }
      if (age !== null && age >= 7) {
        lines.push(
          `⚠ This rate was last published ${age} days ago. The watch can only fire when the source publishes again — ` +
            'a quiet source looks exactly like a flat rate.',
        );
      }

      return textResult(lines.join('\n'), {
        watchlist: list.id,
        watch: { id: watch.id, from: base, to: quote, country: watch.country, condition },
        rate: route.rate,
        as_of: route.asOf,
        age_days: age,
        already_holds: alreadyHolds,
        watch_count: list.watches.length,
      });
    },
  );

  server.registerTool(
    'check_watches',
    {
      title: 'Check a watchlist: what changed since last time',
      description:
        'Re-read every rate on a watchlist and report, for each: whether its condition now holds, how far it ' +
        'has moved since the watch was set, and how far since the previous check — which may have been in an ' +
        'earlier conversation. Also says when a source has published nothing new since the last check, so a ' +
        'quiet source is not mistaken for a steady rate. Call it at the start of a conversation when the user ' +
        'has a watchlist id.',
      inputSchema: { watchlist: listIdSchema },
      outputSchema: {
        watchlist: z.string(),
        last_checked: z.string().nullable(),
        fired: z.number(),
        results: z.array(
          z.object({
            watch: watchShape,
            rate: z.number(),
            as_of: z.string(),
            age_days: z.number().nullable(),
            holds: z.boolean(),
            /** True only on the check where the condition was first seen to hold. */
            newly_fired: z.boolean(),
            /** The condition already held when the watch was set, so firing is not news of a move. */
            held_when_set: z.boolean(),
            change_since_set_pct: z.number(),
            change_since_last_check_pct: z.number(),
            new_publication: z.boolean(),
            stale: z.boolean(),
          }),
        ),
        /** Watches we could not read this time — throttled or upstream failure. Nothing is implied about them. */
        unchecked: z.array(z.object({ id: z.string(), reason: z.string() })),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ watchlist }) => {
      const list = await store.get(watchlist);
      if (!list) {
        return errorResult(
          `No watchlist ${watchlist}. It may have expired after 90 days unused, or the id is mistyped. ` +
            'watch_rate without a watchlist starts a new one.',
        );
      }
      if (list.watches.length === 0) {
        return textResult(`Watchlist ${list.id} is empty. Add a watch with watch_rate.`, {
          watchlist: list.id,
          last_checked: null,
          fired: 0,
          results: [],
          unchecked: [],
        });
      }

      const now = new Date();
      const lastChecked = list.watches.map((w) => w.last.at).sort().at(-1) ?? null;
      const results = [];
      const unchecked: { id: string; reason: string }[] = [];
      let throttled = false;

      // In order, one at a time: a list is at most ten watches, and once the
      // minute's budget is gone the rest would be certain 429s.
      for (const w of list.watches) {
        if (throttled) {
          unchecked.push({ id: w.id, reason: 'not checked — the rate limit was already reached' });
          continue;
        }
        let route: Route | undefined;
        try {
          route = await resolveRoute(client, w.from, w.to, { country: w.country ?? undefined });
        } catch (err) {
          if (err instanceof AfriRateError && err.isRateLimited) throttled = true;
          unchecked.push({ id: w.id, reason: describe(err) });
          continue;
        }
        if (!route) {
          unchecked.push({ id: w.id, reason: 'no published route any more' });
          continue;
        }

        const holdsNow = holds(w.condition, route.rate, w.baseline.rate);
        const newlyFired = holdsNow && w.fired_at === null;
        const result = {
          watch: { id: w.id, from: w.from, to: w.to, country: w.country, condition: w.condition },
          rate: route.rate,
          as_of: route.asOf,
          age_days: ageDays(route.asOf),
          holds: holdsNow,
          newly_fired: newlyFired,
          held_when_set: w.held_when_set === true,
          change_since_set_pct: pct(route.rate, w.baseline.rate),
          change_since_last_check_pct: pct(route.rate, w.last.rate),
          new_publication: route.asOf !== w.last.as_of,
          stale: route.stale,
        };
        results.push(result);

        if (newlyFired) w.fired_at = now.toISOString();
        w.last = observe(route, now);
      }

      // Only what was actually read moves forward; unchecked watches keep their
      // previous reading so the next check still measures from it.
      await store.save(list, now);

      const fired = results.filter((r) => r.holds);
      const lines = [
        `Watchlist ${list.id} — ${list.watches.length} watch${list.watches.length === 1 ? '' : 'es'}` +
          (lastChecked ? `, last checked ${since(lastChecked, now)}.` : '.'),
      ];
      for (const r of [...fired, ...results.filter((x) => !x.holds)]) {
        const w = r.watch;
        const firedHow = r.held_when_set
          ? ' — holds, as it already did when the watch was set (no move implied)'
          : r.newly_fired
            ? ' — fired: it has crossed since the watch was set'
            : ' — still holds';
        const head = r.holds
          ? `🔔 ${sayCondition(w.condition, w.from, w.to)}${firedHow}`
          : `• ${w.from}/${w.to} (${sayCondition(w.condition, w.from, w.to).replace(`${w.from}/${w.to} `, 'waiting until it ')})`;
        const move = r.new_publication
          ? `${signed(r.change_since_last_check_pct)} since the last check, ${signed(r.change_since_set_pct)} since set`
          : `no new publication since the last check — still the ${r.as_of} figure`;
        lines.push(
          `${head}\n  now ${r.rate.toPrecision(8)} as of ${r.as_of}${ageNote(r.as_of)}; ${move}` +
            (r.stale ? '\n  ⚠ the source is currently failing; this is its last published value' : ''),
        );
      }
      if (unchecked.length > 0) {
        lines.push(
          `⚠ Could not check ${unchecked.map((u) => `${u.id} (${u.reason})`).join(', ')}. ` +
            'Nothing is implied about those — retry shortly.',
        );
      }

      return textResult(lines.join('\n'), {
        watchlist: list.id,
        last_checked: lastChecked,
        fired: fired.length,
        results,
        unchecked,
      });
    },
  );

  server.registerTool(
    'remove_watch',
    {
      title: 'Remove a watch',
      description: 'Remove one watch from a watchlist by its id (w1, w2, …), or every watch with id "all".',
      inputSchema: {
        watchlist: listIdSchema,
        watch_id: z.string().describe('The watch to remove, e.g. w2, or "all"'),
      },
      outputSchema: { watchlist: z.string(), removed: z.array(z.string()), remaining: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ watchlist, watch_id }) => {
      const list = await store.get(watchlist);
      if (!list) return errorResult(`No watchlist ${watchlist}.`);

      const removed =
        watch_id === 'all' ? list.watches.map((w) => w.id) : list.watches.filter((w) => w.id === watch_id).map((w) => w.id);
      if (removed.length === 0) {
        return errorResult(
          `No watch ${watch_id} on ${list.id}. It has: ${list.watches.map((w) => w.id).join(', ') || 'none'}.`,
        );
      }
      list.watches = list.watches.filter((w) => !removed.includes(w.id));
      await store.save(list);

      return textResult(`Removed ${removed.join(', ')} from ${list.id}. ${list.watches.length} left.`, {
        watchlist: list.id,
        removed,
        remaining: list.watches.length,
      });
    },
  );
}
