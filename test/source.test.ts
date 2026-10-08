/**
 * Found by putting a real model in front of the server: asked about "the
 * Central Bank of Kenya", it passed that name as `source`, matched nothing,
 * and convert answered "No published route from USD to KES" — about a pair
 * Kenya publishes daily.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sourceMatches } from '../src/route.js';
import { harness } from './client.js';
import { rate, ratesEnvelope, startStub } from './stub.js';

test('a source can be named by its code or by the institution', () => {
  assert.ok(sourceMatches('cbk', 'cbk'));
  assert.ok(sourceMatches('cbk', 'CBK'));
  assert.ok(sourceMatches('cbk', 'Central Bank of Kenya'));
  assert.ok(sourceMatches('cbk', 'the Central Bank of Kenya'));
  assert.ok(sourceMatches('rbz', 'Reserve Bank of Zimbabwe'));
  assert.ok(sourceMatches('bob', 'Bank of Botswana'));
  assert.ok(sourceMatches('sarb', 'South African Reserve Bank'));
  assert.ok(!sourceMatches('cbk', 'Central Bank of Nigeria'));
  assert.ok(!sourceMatches('cbk', 'Kenya'));
});

const kenya = () =>
  startStub(() => ({
    body: ratesEnvelope(
      [
        rate({ source: 'cbk', base: 'USD', quote: 'KES', rate: '129.89' }),
        rate({ source: 'cbk', base: 'GBP', quote: 'KES', rate: '172.28' }),
      ],
      'KE',
    ),
  }));

test('convert accepts the institution name for a source', async () => {
  const stub = await kenya();
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('convert', {
    amount: 250,
    from: 'USD',
    to: 'KES',
    country: 'KE',
    source: 'Central Bank of Kenya',
  });
  assert.equal(reply.isError, false, reply.text);
  assert.equal(reply.structured?.result, 250 * 129.89);
});

test('a source that publishes nothing is named as the problem, not the pair', async () => {
  const stub = await kenya();
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('convert', { amount: 1, from: 'USD', to: 'KES', country: 'KE', source: 'Equity Bank' });
  assert.equal(reply.isError, true);
  assert.doesNotMatch(reply.text, /No published route/);
  assert.match(reply.text, /No source matching "Equity Bank"/);
  assert.match(reply.text, /published by cbk/);
});

test('get_rate with a country and a pair returns only that pair', async () => {
  const stub = await kenya();
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const reply = await h.call('get_rate', { country: 'KE', base: 'USD', quote: 'KES' });
  assert.equal(reply.structured?.count, 1);
  assert.match(reply.text, /\(1 pair\)/);
  assert.doesNotMatch(reply.text, /GBP/);
});

test('an invented currency code is named, with the real ones, instead of "no route"', async () => {
  const stub = await startStub((target) => {
    if (target.pathname.endsWith('/currencies')) {
      return {
        body: {
          data: {
            currencies: [
              { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2 },
              { code: 'ZWG', name: 'Zimbabwe Gold', symbol: 'ZiG', decimals: 2 },
            ],
          },
          meta: { timestamp: new Date().toISOString() },
        },
      };
    }
    return { body: ratesEnvelope([]) };
  });
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  // What a model sent for "Zimbabwe gold".
  const watched = await h.call('watch_rate', { from: 'USD', to: 'ZAG', condition: 'above', value: 27 });
  assert.equal(watched.isError, true);
  assert.match(watched.text, /ZAG is not a currency AfriRate quotes/);
  assert.match(watched.text, /ZWG \(Zimbabwe Gold\)/);

  const converted = await h.call('convert', { amount: 1, from: 'USD', to: 'ZAG' });
  assert.match(converted.text, /ZAG is not a currency/);
});
