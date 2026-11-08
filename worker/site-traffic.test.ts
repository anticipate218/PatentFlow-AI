import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SiteTraffic, trafficVisitorDigest, type TrafficStorage } from './site-traffic.ts';
import worker from './index.ts';
import { authenticated, context, environment } from './test-helpers.ts';
import type { TrafficSnapshot } from '../src/site-traffic-types.ts';

function database(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const storage: TrafficStorage = {
    sql: { exec<T extends Record<string, unknown>>(query: string, ...values: (string | number | null)[]) {
      const rows = db.prepare(query).all(...values) as T[];
      return { toArray: () => rows };
    } },
    transactionSync(operation) {
      db.exec('BEGIN');
      try { const result = operation(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage, counter: new SiteTraffic({ storage }) };
}
const visitorA = 'a'.repeat(64), visitorB = 'b'.repeat(64);
const event = (number: number) => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const record = (counter: SiteTraffic, visitor = visitorA, id = event(1)) => counter.fetch(new Request('https://traffic.internal/record', { method: 'POST', body: JSON.stringify({ visitor, eventId: id }) })).then(response => response.json() as Promise<TrafficSnapshot>);
const summary = (counter: SiteTraffic) => counter.fetch(new Request('https://traffic.internal/summary')).then(response => response.json() as Promise<TrafficSnapshot>);

test('empty traffic starts at zero without fabricating historical visits', async t => {
  const { counter } = database(t); const data = await summary(counter);
  assert.deepEqual(data.total, { views: 0, visitors: 0 }); assert.equal(data.startedAt, null);
  assert.deepEqual((await summary(counter)).total, data.total);
});
test('retries deduplicate while distinct page openings increase PV, not the same visitor UV', async t => {
  const { counter } = database(t);
  await record(counter); await record(counter);
  const data = await record(counter, visitorA, event(2));
  assert.deepEqual(data.total, { views: 2, visitors: 1 });
  assert.equal(data.today.visitors, 1);
  assert.deepEqual((await record(counter, visitorB)).total, { views: 3, visitors: 2 });
});
test('same page ID from different visitors is not a shared deduplication key', async t => {
  const { counter } = database(t);
  await record(counter); assert.equal((await record(counter, visitorB)).total.views, 2);
});
test('daily UV and PV reset at Beijing midnight while all-time values survive', async t => {
  const { counter } = database(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-08T15:59:00Z'));
  await record(counter);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-08T16:00:00Z'));
  assert.deepEqual((await summary(counter)).today, { day: '2026-11-09', views: 0, visitors: 0 });
  assert.equal((await record(counter)).today.views, 0, 'midnight retry must remain deduplicated');
  const data = await record(counter, visitorA, event(2));
  assert.deepEqual(data.today, { day: '2026-11-09', views: 1, visitors: 1 });
  assert.deepEqual(data.total, { views: 2, visitors: 1 });
});
test('concurrent event writes and object replacement preserve exact counters', async t => {
  const { counter, storage } = database(t);
  await Promise.all(Array.from({ length: 30 }, (_, i) => record(counter, i % 2 ? visitorA : visitorB, event(i))));
  const restored = new SiteTraffic({ storage });
  assert.deepEqual((await summary(restored)).total, { views: 30, visitors: 2 });
  assert.deepEqual((await record(restored, visitorB, event(0))).total, { views: 30, visitors: 2 });
});
test('partially failed SQL transactions never leave phantom visitors or events', async t => {
  const { counter, storage, db } = database(t);
  const original = storage.sql.exec;
  t.mock.method(storage.sql, 'exec', (query: string, ...values: (string | number | null)[]) => {
    if (query.startsWith('UPDATE traffic_total')) throw new Error('synthetic storage failure');
    return original(query, ...values);
  });
  await assert.rejects(record(counter));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM traffic_events').get()!.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM traffic_visitors').get()!.count, 0);
  assert.equal((await summary(counter)).total.views, 0);
});
test('short-lived event records are pruned, but cumulative aggregates remain', async t => {
  const { counter, db } = database(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-01T00:00:00Z')); await record(counter);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-04T00:00:00Z')); await record(counter, visitorA, event(2));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM traffic_events').get()!.count, 1);
  assert.deepEqual((await summary(counter)).total, { views: 2, visitors: 1 });
});
test('internal traffic has no public reset route and rejects arbitrary identities', async t => {
  const { counter } = database(t);
  assert.equal((await counter.fetch(new Request('https://traffic.internal/reset', { method: 'POST' }))).status, 404);
  assert.equal((await counter.fetch(new Request('https://traffic.internal/record', { method: 'POST', body: JSON.stringify({ visitor: 'raw-ip', eventId: event(1) }) }))).status, 400);
  assert.equal((await summary(counter)).total.views, 0);
});
test('visitor digest is deterministic, scoped, and not the original session tag', async () => {
  const first = await trafficVisitorDigest('synthetic-secret', 'synthetic-session');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, await trafficVisitorDigest('synthetic-secret', 'synthetic-session'));
  assert.notEqual(first, await trafficVisitorDigest('different-secret', 'synthetic-session'));
});

function routeEnv() {
  const calls: Request[] = [];
  const sample = { ok: true, timezone: 'Asia/Shanghai', startedAt: null, total: { views: 0, visitors: 0 }, today: { day: '2026-11-08', views: 0, visitors: 0 } };
  const env = environment({ ACCESS_MODE: 'public', SITE_TRAFFIC: { idFromName: name => name, get: id => ({ fetch: async request => {
    assert.equal(id, 'site-traffic-v1'); calls.push(request); return Response.json(sample);
  } }) } });
  return { env, calls };
}
test('traffic API requires current notice and never calls the model or search', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No upstream expected'); });
  const { env, calls } = routeEnv();
  assert.equal((await worker.fetch(new Request('https://app.example.test/api/traffic'), env, context())).status, 428);
  assert.equal((await worker.fetch(await authenticated('/api/traffic', env), env, context())).status, 200);
  assert.equal(calls[0].method, 'GET');
  const response = await worker.fetch(await authenticated('/api/traffic', env, { method: 'POST', body: JSON.stringify({ eventId: event(1) }) }), env, context());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await calls[1].json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ['eventId', 'visitor']);
  assert.match(payload.visitor as string, /^[a-f0-9]{64}$/);
  assert.equal(calls[1].headers.get('Cookie'), null); assert.equal(calls[1].headers.get('Authorization'), null);
});
for (const headers of [{ DNT: '1' }, { 'Sec-GPC': '1' }, { 'User-Agent': 'Googlebot' }] as Record<string, string>[]) {
  test('privacy signals and known bots fetch aggregates without incrementing: ' + JSON.stringify(headers), async () => {
    const { env, calls } = routeEnv();
    const request = await authenticated('/api/traffic', env, { method: 'POST', headers, body: JSON.stringify({ eventId: event(1) }) });
    assert.equal((await worker.fetch(request, env, context())).status, 200);
    assert.equal(calls[0].method, 'GET');
  });
}
test('traffic rejects foreign origins, oversized bodies, forged visitor IDs and malformed JSON', async () => {
  const { env, calls } = routeEnv();
  for (const [body, headers, status] of [
    [JSON.stringify({ eventId: event(1) }), { Origin: 'https://evil.example' }, 403],
    ['x'.repeat(300), {}, 413],
    [JSON.stringify({ eventId: event(1), visitor: visitorB }), {}, 400],
    ['{', {}, 400],
  ] as [string, Record<string, string>, number][]) {
    const request = await authenticated('/api/traffic', env, { method: 'POST', headers, body });
    assert.equal((await worker.fetch(request, env, context())).status, status);
  }
  assert.equal(calls.length, 0);
});
test('unavailable metrics fail independently, without leaking storage exceptions', async () => {
  const env = environment({ ACCESS_MODE: 'public' });
  assert.equal((await worker.fetch(await authenticated('/api/traffic', env), env, context())).status, 503);
  assert.equal((await worker.fetch(await authenticated('/api/providers', env), env, context())).status, 200);
  env.SITE_TRAFFIC = { idFromName: () => 'test', get: () => ({ fetch: async () => { throw new Error('private synthetic failure'); } }) };
  const response = await worker.fetch(await authenticated('/api/traffic', env), env, context());
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private synthetic/);
});
