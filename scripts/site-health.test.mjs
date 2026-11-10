import test from 'node:test';
import assert from 'node:assert/strict';
import { runSiteHealth } from './site-health.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname; calls.push({ url: String(url), path, method: init.method || 'GET' });
    if (overrides[path]) return overrides[path](init);
    if (path === '/api/access') return Response.json({ mode: 'public', requiresInvite: false, noticeVersion: 'test-v1' });
    if (path === '/__notice') return new Response(null, { status: 303, headers: { 'Set-Cookie': 'pf_session=synthetic-session; Secure; HttpOnly; SameSite=Lax' } });
    if (path === '/api/providers') return init.headers?.Cookie ? Response.json({ providers: [{ hasKey: true }] }) : Response.json({}, { status: 428 });
    if (path === '/api/traffic') return Response.json({ ok: true, timezone: 'Asia/Shanghai', startedAt: null, total: { views: 0, visitors: 0 }, today: { day: '2026-11-10', views: 0, visitors: 0 } });
    if (path === '/assets/main.js') return new Response('console.log("synthetic")', { headers: { 'Content-Type': 'application/javascript' } });
    return new Response(init.headers?.Cookie ? '<div id="root"></div><script type="module" src="/assets/main.js"></script>' : '<h1>免责声明</h1>');
  };
  return { calls, fetchImpl };
}
test('scheduled health only reads APIs and never consumes model, search or traffic events', async () => {
  const { calls, fetchImpl } = fixture(); const result = await runSiteHealth({ fetchImpl });
  assert.equal(result.ok, true); assert.equal(result.checks.length, 9);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/__notice']);
  assert.ok(!calls.some(call => /chat|agent|search|extract/.test(call.path)));
});
test('an unavailable network does not expose exceptions or credentials in a health report', async () => {
  const result = await runSiteHealth({ fetchImpl: async () => { throw new Error('private-diagnostic'); } });
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('private-diagnostic'));
});
test('HTML fallback for JavaScript is a failed deployment check', async () => {
  const { fetchImpl } = fixture({ '/assets/main.js': () => new Response('<html>gate</html>', { headers: { 'Content-Type': 'text/html' } }) });
  const result = await runSiteHealth({ fetchImpl }); assert.equal(result.ok, false);
});
test('a script in returned HTML cannot make health fetch external or private hosts', async () => {
  const { calls, fetchImpl } = fixture({ '/': init => new Response(init.headers?.Cookie ? '<div id="root"></div><script type="module" src="https://private.example/asset.js"></script>' : '免责声明') });
  assert.equal((await runSiteHealth({ fetchImpl })).ok, false);
  assert.ok(calls.every(call => new URL(call.url).host === 'patentflow-ai.patentflow-ai.workers.dev'));
});
test('missing statistics are not replaced with synthetic healthy zeroes', async () => {
  const { fetchImpl } = fixture({ '/api/traffic': () => Response.json({ ok: false }, { status: 503 }) });
  assert.equal((await runSiteHealth({ fetchImpl })).ok, false);
});
test('oversized responses are stopped rather than buffered without a limit', async () => {
  const { fetchImpl } = fixture({ '/api/access': () => new Response('large', { headers: { 'Content-Length': '4000000' } }) });
  assert.equal((await runSiteHealth({ fetchImpl })).ok, false);
});
