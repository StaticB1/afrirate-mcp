/**
 * Watchlists — the state that outlives a conversation.
 *
 * Each "session" below is a separate harness: a new MCP server, a new client
 * and a new WatchStore reading the same directory, which is what a judge's
 * second conversation (or a restart of the service) looks like from here.
 * Rate caching is off so a changed upstream figure is seen at once.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { harness } from './client.js';
import { rate, ratesEnvelope, startStub, TODAY, type StubReply } from './stub.js';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** A USD/ZWG market whose figure and publication date the test can move. */
function market(start: { rate: string; date: string }) {
  const state = { ...start, throttle: false };
  const handler = (target: URL): StubReply => {
    if (state.throttle) {
      return {
        status: 429,
        headers: { 'retry-after': '30', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0' },
        body: { error: { code: 'rate_limited', message: 'too many requests' } },
      };
    }
    const base = target.searchParams.get('base');
    const quote = target.searchParams.get('quote');
    if (base === 'USD' && quote === 'ZWG') {
      return {
        body: ratesEnvelope([rate({ source: 'rbz', base: 'USD', quote: 'ZWG', rate: state.rate, rate_date: state.date })]),
      };
    }
    return { body: ratesEnvelope([]) };
  };
  return { state, handler };
}

async function session(apiBase: string, stateDir: string) {
  return harness({ AFRIRATE_API_BASE: apiBase, AFRIRATE_STATE_DIR: stateDir, AFRIRATE_CACHE_TTL_MS: '0' });
}

test('a watch set in one conversation fires in the next, and says what moved since', async () => {
  const m = market({ rate: '26.6', date: daysAgo(1) });
  const stub = await startStub(m.handler);
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  after(() => stub.close());

  const first = await session(stub.base, dir);
  const set = await first.call('watch_rate', { from: 'USD', to: 'ZWG', above: 27 });
  await first.close();

  assert.equal(set.isError, false, set.text);
  const id = set.structured?.watchlist as string;
  assert.match(id, /^wl_[a-z2-9]{10}$/);
  assert.match(set.text, new RegExp(id), 'the id has to reach the user, or the list is unreachable');
  assert.equal(set.structured?.already_holds, false);

  // Next day: RBZ publishes 27.2.
  m.state.rate = '27.2';
  m.state.date = TODAY;

  const second = await session(stub.base, dir);
  after(() => second.close());
  const checked = await second.call('check_watches', { watchlist: id });

  assert.equal(checked.isError, false, checked.text);
  assert.equal(checked.structured?.fired, 1);
  const [r] = checked.structured?.results as {
    holds: boolean;
    newly_fired: boolean;
    new_publication: boolean;
    change_since_last_check_pct: number;
  }[];
  assert.equal(r!.holds, true);
  assert.equal(r!.newly_fired, true);
  assert.equal(r!.new_publication, true);
  assert.ok(Math.abs(r!.change_since_last_check_pct - 2.2556) < 0.01, `got ${r!.change_since_last_check_pct}`);
  assert.match(checked.text, /🔔 USD\/ZWG goes above 27 — fired for the first time/);

  // A third look: still holds, but it is not news any more.
  const again = await second.call('check_watches', { watchlist: id });
  const [r2] = again.structured?.results as { holds: boolean; newly_fired: boolean; new_publication: boolean }[];
  assert.equal(r2!.holds, true);
  assert.equal(r2!.newly_fired, false);
  assert.equal(r2!.new_publication, false);
  assert.match(again.text, /still holds/);
});

test('a source that published nothing new is reported as quiet, not as a flat rate', async () => {
  const m = market({ rate: '26.6', date: daysAgo(30) });
  const stub = await startStub(m.handler);
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const h = await session(stub.base, dir);
  after(async () => {
    await h.close();
    await stub.close();
  });

  const set = await h.call('watch_rate', { from: 'USD', to: 'ZWG', moves_pct: 2 });
  assert.match(set.text, /last published 30 days ago/, 'an old baseline must be called out when the watch is set');

  const checked = await h.call('check_watches', { watchlist: set.structured?.watchlist as string });
  const [r] = checked.structured?.results as { new_publication: boolean; holds: boolean }[];
  assert.equal(r!.new_publication, false);
  assert.equal(r!.holds, false);
  assert.match(checked.text, /no new publication since the last check/);
  assert.match(checked.text, /30 days old/);
});

test('moves_pct fires on a move either way', async () => {
  const m = market({ rate: '100', date: daysAgo(1) });
  const stub = await startStub(m.handler);
  const h = await session(stub.base, await mkdtemp(join(tmpdir(), 'watch-')));
  after(async () => {
    await h.close();
    await stub.close();
  });

  const id = (await h.call('watch_rate', { from: 'USD', to: 'ZWG', moves_pct: 3 })).structured?.watchlist as string;

  m.state.rate = '98';
  m.state.date = TODAY;
  assert.equal((await h.call('check_watches', { watchlist: id })).structured?.fired, 0, '−2% is inside 3%');

  m.state.rate = '96.5';
  const fell = await h.call('check_watches', { watchlist: id });
  assert.equal(fell.structured?.fired, 1, '−3.5% from the baseline, not from the last check');
});

test('a throttled check reports the watch as unchecked and keeps its last reading', async () => {
  const m = market({ rate: '26.6', date: daysAgo(1) });
  const stub = await startStub(m.handler);
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const h = await session(stub.base, dir);
  after(async () => {
    await h.close();
    await stub.close();
  });

  const id = (await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 27 })).structured?.watchlist as string;
  const before = await readFile(join(dir, 'watches.json'), 'utf8');

  m.state.throttle = true;
  const checked = await h.call('check_watches', { watchlist: id });
  assert.equal(checked.isError, false);
  assert.equal(checked.structured?.fired, 0);
  assert.equal((checked.structured?.results as unknown[]).length, 0);
  assert.equal((checked.structured?.unchecked as unknown[]).length, 1);
  assert.match(checked.text, /Could not check w1/);
  assert.match(checked.text, /Nothing is implied/);

  const kept = JSON.parse(await readFile(join(dir, 'watches.json'), 'utf8'));
  assert.deepEqual(kept.lists[0].watches[0].last, JSON.parse(before).lists[0].watches[0].last);
});

test('bad input is refused before anything is saved', async () => {
  const m = market({ rate: '26.6', date: TODAY });
  const stub = await startStub(m.handler);
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const h = await session(stub.base, dir);
  after(async () => {
    await h.close();
    await stub.close();
  });

  const two = await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 27, below: 25 });
  assert.equal(two.isError, true);
  assert.match(two.text, /exactly one condition/);

  const none = await h.call('watch_rate', { from: 'USD', to: 'ZWG' });
  assert.equal(none.isError, true);

  const unknown = await h.call('check_watches', { watchlist: 'wl_aaaaaaaaaa' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No watchlist/);

  const nonsense = await h.call('check_watches', { watchlist: '../../etc/passwd' });
  assert.equal(nonsense.isError, true);

  const noRoute = await h.call('watch_rate', { from: 'GBP', to: 'XOF', above: 1 });
  assert.equal(noRoute.isError, true);
  assert.equal(h.store.size, 0, 'no list is created for a watch that could not be set');
});

test('a list holds at most ten watches, and remove_watch frees a slot', async () => {
  const m = market({ rate: '26.6', date: TODAY });
  const stub = await startStub(m.handler);
  const h = await session(stub.base, await mkdtemp(join(tmpdir(), 'watch-')));
  after(async () => {
    await h.close();
    await stub.close();
  });

  const id = (await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 27 })).structured?.watchlist as string;
  for (let i = 0; i < 9; i++) {
    const added = await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 28 + i, watchlist: id });
    assert.equal(added.isError, false, added.text);
  }
  const full = await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 40, watchlist: id });
  assert.equal(full.isError, true);
  assert.match(full.text, /already has 10 watches/);

  const removed = await h.call('remove_watch', { watchlist: id, watch_id: 'w3' });
  assert.deepEqual(removed.structured?.removed, ['w3']);
  const added = await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 40, watchlist: id });
  assert.equal(added.structured?.watch && (added.structured.watch as { id: string }).id, 'w11', 'ids are never reused');

  const cleared = await h.call('remove_watch', { watchlist: id, watch_id: 'all' });
  assert.equal(cleared.structured?.remaining, 0);
});

test('a corrupt store file is refused, never silently replaced', async () => {
  const m = market({ rate: '26.6', date: TODAY });
  const stub = await startStub(m.handler);
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  await writeFile(join(dir, 'watches.json'), '{ not json');
  const h = await session(stub.base, dir);
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('watch_rate', { from: 'USD', to: 'ZWG', above: 27 });
  assert.equal(reply.isError, true);
  assert.equal(await readFile(join(dir, 'watches.json'), 'utf8'), '{ not json');
});
