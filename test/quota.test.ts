/**
 * What a tool call costs upstream. Each of these pins a specific way the
 * server used to spend its 10-requests-a-minute budget on nothing.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AfriRateError, AfriRateClient } from '../src/afrirate.js';
import { loadConfig } from '../src/config.js';
import { harness } from './client.js';
import { ratesEnvelope, rate, startStub } from './stub.js';

const zwRows = [
  rate({ source: 'rbz', base: 'USD', quote: 'ZWG', rate: '26.5' }),
  rate({ source: 'rbz', base: 'ZWG', quote: 'ZAR', rate: '0.68' }),
];

test('the same rate question twice costs one upstream request', async () => {
  const stub = await startStub(() => ({ body: ratesEnvelope(zwRows, 'ZW') }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  await h.call('get_rate', { country: 'ZW' });
  await h.call('get_rate', { country: 'ZW' });

  assert.equal(stub.hits(), 1, 'the second call must be served from cache');
  assert.equal(h.api.cacheStats().hits, 1);
});

test('concurrent identical questions collapse into one upstream request', async () => {
  let inflight = 0;
  let maxInflight = 0;
  const stub = await startStub(() => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    inflight -= 1;
    return { body: ratesEnvelope(zwRows, 'ZW') };
  });
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  await Promise.all(Array.from({ length: 5 }, () => h.call('get_rate', { country: 'ZW' })));

  assert.equal(stub.hits(), 1);
  assert.equal(maxInflight, 1);
});

test('a cross-USD convert restricted to one country costs one upstream request, not five', async () => {
  // ZW publishes USD/ZWG and USD/ZAR but nothing joining ZAR to ZWG, so
  // converting between them walks direct, inverse, then both halves of a cross
  // through USD: five probes, each of which is the identical
  // /rates/latest?country=ZW URL because the country form returns every pair
  // and we filter locally. Measured at five without the cache, below.
  const crossOnly = [
    rate({ source: 'rbz', base: 'USD', quote: 'ZWG', rate: '26.5' }),
    rate({ source: 'rbz', base: 'USD', quote: 'ZAR', rate: '17.3' }),
  ];
  const args = { amount: 100, from: 'ZAR', to: 'ZWG', country: 'ZW' };

  const uncachedStub = await startStub(() => ({ body: ratesEnvelope(crossOnly, 'ZW') }));
  const uncached = await harness({ AFRIRATE_API_BASE: uncachedStub.base, AFRIRATE_CACHE_TTL_MS: '0' });
  await uncached.call('convert', args);
  assert.equal(uncachedStub.hits('/rates/latest'), 5, 'the cost this test exists to remove');
  await uncached.close();
  await uncachedStub.close();

  const stub = await startStub(() => ({ body: ratesEnvelope(crossOnly, 'ZW') }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('convert', args);

  assert.equal(reply.isError, false, reply.text);
  assert.equal(stub.hits('/rates/latest'), 1);
  assert.equal(reply.structured?.path, 'cross-usd');
});

test('lookups are cached for longer than rates', async () => {
  const stub = await startStub((target) =>
    target.pathname === '/countries'
      ? { body: { data: { countries: [{ code: 'ZW', name: 'Zimbabwe', slug: 'zw', timezone: 'Africa/Harare', sources: 2 }] }, meta: { timestamp: '' } } }
      : { body: ratesEnvelope(zwRows, 'ZW') },
  );
  // Rates TTL of zero proves the two TTLs are independent: rates refetch, the
  // country list does not.
  const h = await harness({ AFRIRATE_API_BASE: stub.base, AFRIRATE_CACHE_TTL_MS: '0' });
  after(async () => {
    await h.close();
    await stub.close();
  });

  await h.call('list_countries');
  await h.call('list_countries');
  await h.call('get_rate', { country: 'ZW' });
  await h.call('get_rate', { country: 'ZW' });

  assert.equal(stub.hits('/countries'), 1);
  assert.equal(stub.hits('/rates/latest'), 2, 'a zero TTL must actually disable rate caching');
});

test('a 429 is typed as rate_limited, carries a retry hint, and is not cached', async () => {
  let served = 0;
  const stub = await startStub(() => {
    served += 1;
    return {
      status: 429,
      headers: { 'retry-after': '17', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0' },
      body: { error: { code: 'rate_limited', message: 'too many requests' } },
    };
  });
  after(() => stub.close());

  const api = new AfriRateClient(loadConfig({ AFRIRATE_API_BASE: stub.base, AFRIRATE_MCP_API_KEY: 'k' } as NodeJS.ProcessEnv));

  for (const attempt of [1, 2]) {
    const err = await api.rates({ country: 'ZW' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AfriRateError, `attempt ${attempt} should reject`);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.isRateLimited, true);
    assert.equal(err.retryAfterSec, 17);
    assert.match(err.message, /10 requests\/minute/);
  }

  assert.equal(served, 2, 'a throttle must not be cached and replayed as an answer');
  assert.equal(api.quota()?.remaining, 0, 'quota headers are read from error responses too');
});

test('quota figures are read from successful responses', async () => {
  const reset = Math.floor(Date.now() / 1000) + 42;
  const stub = await startStub(() => ({
    headers: { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': String(reset) },
    body: ratesEnvelope(zwRows, 'ZW'),
  }));
  after(() => stub.close());

  const api = new AfriRateClient(loadConfig({ AFRIRATE_API_BASE: stub.base, AFRIRATE_MCP_API_KEY: 'k' } as NodeJS.ProcessEnv));
  await api.rates({ country: 'ZW' });

  assert.equal(api.quota()?.limit, 10);
  assert.equal(api.quota()?.remaining, 7);
  assert.equal(api.quota()?.resetAt, new Date(reset * 1000).toISOString());
});
