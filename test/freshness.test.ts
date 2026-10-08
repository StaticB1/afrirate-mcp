/**
 * Data age, which is not the `stale` flag.
 *
 * `stale` says the scraper is failing. A source can scrape cleanly and still
 * not have moved its numbers in three weeks — Zimbabwe's RBZ rows have been
 * exactly that since 2026-08-24, returning `stale: false` with a rate_date
 * weeks old. Presenting that as this morning's rate is the failure mode.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ageDays, ageNote } from '../src/format.js';
import { harness } from './client.js';
import { rate, ratesEnvelope, startStub } from './stub.js';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test('ageDays and ageNote', () => {
  assert.equal(ageDays(daysAgo(0)), 0);
  assert.equal(ageDays(daysAgo(24)), 24);
  assert.equal(ageDays('not-a-date'), null);
  assert.equal(ageNote(daysAgo(0)), '', 'today needs no note');
  assert.equal(ageNote(daysAgo(6)), '', 'inside a week is current enough to pass without comment');
  assert.match(ageNote(daysAgo(24)), /24 days old/);
});

test('a fresh-looking but weeks-old rate says how old it is', async () => {
  const stub = await startStub(() => ({
    body: ratesEnvelope(
      [rate({ source: 'rbz', base: 'USD', quote: 'ZWG', rate: '26.5', rate_date: daysAgo(24), stale: false })],
      'ZW',
    ),
  }));
  const h = await harness({ AFRIRATE_API_BASE: stub.base });
  after(async () => {
    await h.close();
    await stub.close();
  });

  const listed = await h.call('get_rate', { country: 'ZW' });
  assert.match(listed.text, /24 days old/);
  assert.doesNotMatch(listed.text, /STALE/, 'the source is not failing; only its data is old');

  const converted = await h.call('convert', { amount: 100, from: 'USD', to: 'ZWG', country: 'ZW' });
  assert.equal(converted.structured?.age_days, 24);
  assert.equal(converted.structured?.stale, false);
  assert.match(converted.text, /published 24 days ago/);

  const compared = await h.call('compare_corridor', { base: 'USD', quote: 'ZWG', countries: ['ZW'] });
  assert.match(compared.text, /24 days old/);
});
