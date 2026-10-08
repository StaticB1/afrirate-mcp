/**
 * compare_corridor. Three of these pin defects that made the tool look broken
 * or, worse, made it answer wrongly:
 *
 *   • a source that publishes only the reverse direction was invisible
 *   • a single published quote was reported as "Spread 0.00%"
 *   • a throttled country was reported as a country with no such rate
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { harness } from './client.js';
import { rate, ratesEnvelope, startStub } from './stub.js';

/** Botswana quotes BWP→ZAR; South Africa quotes ZAR→BWP. Nobody quotes both. */
const bwpZar = (target: URL) => {
  const base = target.searchParams.get('base');
  const quote = target.searchParams.get('quote');
  if (base === 'BWP' && quote === 'ZAR') {
    return { body: ratesEnvelope([rate({ source: 'bob', base: 'BWP', quote: 'ZAR', rate: '1.2317' })]) };
  }
  if (base === 'ZAR' && quote === 'BWP') {
    return { body: ratesEnvelope([rate({ source: 'sarb', base: 'ZAR', quote: 'BWP', rate: '0.8302' })]) };
  }
  return { body: ratesEnvelope([]) };
};

test('a source publishing only the reverse direction is still compared', async () => {
  const stub = await startStub(bwpZar);
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('compare_corridor', { base: 'BWP', quote: 'ZAR' });

  assert.equal(reply.isError, false, reply.text);
  assert.equal(reply.structured?.count, 2, 'both directions must be fetched, not just the first non-empty one');
  assert.equal(reply.structured?.single_source, false);
  const sources = (reply.structured?.quotes as { source: string }[]).map((q) => q.source).sort();
  assert.deepEqual(sources, ['bob', 'sarb']);
  // 1/0.8302 = 1.2045 against bob's 1.2317 — a real 2.3% disagreement.
  assert.ok((reply.structured?.spread_pct as number) > 2);
  assert.match(reply.text, /Spread across sources/);
});

test('one published quote is reported as one quote, not as a zero spread', async () => {
  const stub = await startStub(() => ({
    body: ratesEnvelope([rate({ source: 'cbk', base: 'USD', quote: 'KES', rate: '129.4' })]),
  }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('compare_corridor', { base: 'USD', quote: 'KES' });

  assert.equal(reply.isError, false, reply.text);
  assert.equal(reply.structured?.single_source, true);
  assert.equal(reply.structured?.spread_pct, null, 'no comparison was made, so there is no spread');
  assert.doesNotMatch(reply.text, /0\.00%/);
  assert.match(reply.text, /Only cbk publishes USD\/KES/);
});

test('a source quoting both directions is counted once', async () => {
  // Reading a number and its own reciprocal as two opinions would invent a
  // spread out of nothing.
  const both = [
    rate({ source: 'rbz', base: 'USD', quote: 'ZWG', rate: '26.5' }),
    rate({ source: 'rbz', base: 'ZWG', quote: 'USD', rate: '0.0377358' }),
  ];
  const stub = await startStub(() => ({ body: ratesEnvelope(both, 'ZW') }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('compare_corridor', { base: 'USD', quote: 'ZWG', countries: ['ZW'] });

  assert.equal(reply.structured?.count, 1);
  assert.equal(reply.structured?.single_source, true);
  const quotes = reply.structured?.quotes as { inverted: boolean }[];
  assert.equal(quotes[0]?.inverted, false, 'the direction the source actually publishes wins');
});

test('a throttled country is reported as unchecked, never as having no such rate', async () => {
  const stub = await startStub((target) => {
    const country = target.searchParams.get('country');
    if (country === 'KE') {
      return { body: ratesEnvelope([rate({ source: 'cbk', base: 'USD', quote: 'KES', rate: '129.4' })], 'KE') };
    }
    if (country === 'UG') {
      return { body: ratesEnvelope([rate({ source: 'bou', base: 'USD', quote: 'UGX', rate: '3600' })], 'UG') };
    }
    return {
      status: 429,
      headers: { 'retry-after': '25', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0' },
      body: { error: { code: 'rate_limited', message: 'too many requests' } },
    };
  });
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('compare_corridor', { base: 'USD', quote: 'KES', countries: ['KE', 'TZ', 'UG'] });

  assert.equal(reply.isError, false, reply.text);
  // UG answered and publishes no USD/KES: that is a real absence.
  assert.deepEqual(reply.structured?.unavailable, ['UG']);
  // TZ was throttled: we do not know, and must not imply we do.
  const errors = reply.structured?.errors as { target: string; reason: string }[];
  assert.deepEqual(errors.map((e) => e.target), ['TZ']);
  assert.match(errors[0]!.reason, /rate limit/i);
  assert.match(reply.text, /Could not check TZ/);
  assert.doesNotMatch(reply.text, /quote published by: .*TZ/);
});

test('when the throttle leaves nothing to compare, the answer is an error and not an absence', async () => {
  const stub = await startStub(() => ({
    status: 429,
    headers: { 'retry-after': '30', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0' },
    body: { error: { code: 'rate_limited', message: 'too many requests' } },
  }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('compare_corridor', { base: 'USD', quote: 'KES', countries: ['KE', 'TZ'] });

  assert.equal(reply.isError, true);
  assert.match(reply.text, /rate limit, not an answer/);
  assert.doesNotMatch(reply.text, /Nobody publishes/);
});

test('the rate limit stops further country requests instead of spending them on certain 429s', async () => {
  const stub = await startStub(() => ({
    status: 429,
    headers: { 'retry-after': '30' },
    body: { error: { code: 'rate_limited', message: 'too many requests' } },
  }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  await h.call('compare_corridor', {
    base: 'USD',
    quote: 'KES',
    countries: ['KE', 'TZ', 'UG', 'ZA', 'ZW', 'NG', 'GH', 'MW', 'ZM', 'BW'],
  });

  // Three workers are in flight when the first 429 lands, so at most three
  // requests are spent. The other seven are reported unchecked, not retried.
  assert.ok(stub.hits() <= 3, `spent ${stub.hits()} requests into a known-closed window`);
});

test('a country asked for twice is asked upstream once', async () => {
  const stub = await startStub(() => ({
    body: ratesEnvelope([rate({ source: 'cbk', base: 'USD', quote: 'KES', rate: '129.4' })], 'KE'),
  }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('compare_corridor', { base: 'USD', quote: 'KES', countries: ['KE', 'ke'] });

  assert.equal(stub.hits('/rates/latest'), 1);
  assert.equal(reply.structured?.count, 1);
});
