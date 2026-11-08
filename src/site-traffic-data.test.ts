import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficClient, parseTrafficSnapshot } from './site-traffic-data.ts';

const sample = { ok: true, timezone: 'Asia/Shanghai', startedAt: null, total: { views: 0, visitors: 0 }, today: { day: '2026-11-08', views: 0, visitors: 0 } };
const eventId = '00000000-0000-4000-8000-000000000001';
test('StrictMode and duplicate component mounts share one record request', async () => {
  const requests: RequestInit[] = [];
  const client = createTrafficClient(async (_url, init) => { requests.push(init!); return Response.json(sample); }, eventId);
  await Promise.all([client.record(), client.record(), client.record()]);
  await client.record();
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body as string), { eventId });
});
test('manual refresh only reads statistics and never increases views', async () => {
  const methods: string[] = [];
  const client = createTrafficClient(async (_url, init) => { methods.push(init!.method!); return Response.json(sample); }, eventId);
  await client.record(); await client.refresh(); await client.refresh();
  assert.deepEqual(methods, ['POST', 'GET', 'GET']);
});
test('transport failure retries reuse the same page ID for server deduplication', async () => {
  const bodies: unknown[] = [];
  const client = createTrafficClient(async (_url, init) => { bodies.push(init?.body); if (bodies.length === 1) throw new Error('offline'); return Response.json(sample); }, eventId);
  await assert.rejects(client.record()); await client.record();
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});
test('privacy preference skips counting while retaining read-only statistics', async () => {
  const methods: string[] = [];
  const client = createTrafficClient(async (_url, init) => { methods.push(init!.method!); return Response.json(sample); }, eventId, true);
  await client.record(); await client.refresh();
  assert.deepEqual(methods, ['GET', 'GET']);
});
test('invalid statistics are not displayed as fabricated zero counts', () => {
  for (const invalid of [null, {}, { ...sample, total: { views: -1, visitors: 0 } }, { ...sample, today: { ...sample.today, visitors: '42' } }]) {
    assert.throws(() => parseTrafficSnapshot(invalid));
  }
  assert.deepEqual(parseTrafficSnapshot(sample), sample);
});
