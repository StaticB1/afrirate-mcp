/**
 * The hosted server must not give keyless callers more than AfriRate's Free
 * plan, and a caller's own key must be recognised so their plan applies.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callerKey, countToolCalls, FreeAllowance, limitMessage } from '../src/access.js';

const KEY = `ar_${'0a'.repeat(16)}`;

test('an AfriRate key in Authorization is the caller key; anything else is not', () => {
  assert.equal(callerKey(`Bearer ${KEY}`), KEY);
  assert.equal(callerKey(`bearer  ${KEY} `), KEY);
  assert.equal(callerKey(undefined), undefined);
  assert.equal(callerKey('Bearer some-oauth-token'), undefined);
  assert.equal(callerKey(`Basic ${KEY}`), undefined);
});

test('the key may come on the URL as ?api_key=, for clients that cannot set headers', () => {
  assert.equal(callerKey(undefined, new URLSearchParams(`api_key=${KEY}`)), KEY);
  assert.equal(callerKey(undefined, new URLSearchParams('api_key=not-a-key')), undefined);
  const other = `ar_${'1b'.repeat(16)}`;
  assert.equal(callerKey(`Bearer ${other}`, new URLSearchParams(`api_key=${KEY}`)), other, 'the header wins');
});

test('only tools/call counts against the allowance', () => {
  assert.equal(countToolCalls({ method: 'initialize' }), 0);
  assert.equal(countToolCalls({ method: 'tools/list' }), 0);
  assert.equal(countToolCalls({ method: 'tools/call' }), 1);
  assert.equal(countToolCalls([{ method: 'tools/call' }, { method: 'tools/call' }, { method: 'ping' }]), 2);
});

test('the per-minute window refuses the 11th call and reopens after a minute', () => {
  let now = Date.parse('2026-10-21T10:00:00Z');
  const a = new FreeAllowance({ perMinute: 10, perDay: 300 }, () => now);
  for (let i = 0; i < 10; i++) assert.deepEqual(a.take('1.2.3.4', 1), { ok: true });

  const refused = a.take('1.2.3.4', 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.window, 'minute');
  assert.deepEqual(a.take('5.6.7.8', 1), { ok: true }, 'another IP has its own allowance');

  now += 60_000;
  assert.deepEqual(a.take('1.2.3.4', 1), { ok: true });
});

test('the daily cap holds across minutes and resets at UTC midnight', () => {
  let now = Date.parse('2026-10-21T23:00:00Z');
  const a = new FreeAllowance({ perMinute: 10, perDay: 20 }, () => now);
  a.take('ip', 10);
  now += 60_000;
  a.take('ip', 10);
  now += 60_000;

  const refused = a.take('ip', 1);
  assert.equal(refused.ok === false && refused.window, 'day');
  assert.ok(refused.ok === false && refused.retryAfterSec > 0 && refused.retryAfterSec <= 3600);
  assert.match(limitMessage({ perMinute: 10, perDay: 20 }, refused as Extract<typeof refused, { ok: false }>), /20 tool calls a day.*Authorization: Bearer/);

  now = Date.parse('2026-10-22T00:00:01Z');
  assert.deepEqual(a.take('ip', 1), { ok: true });
});

test('a batch is all or nothing', () => {
  const a = new FreeAllowance({ perMinute: 3, perDay: 300 }, () => 0);
  a.take('ip', 2);
  assert.equal(a.take('ip', 2).ok, false);
  assert.deepEqual(a.take('ip', 1), { ok: true });
});
