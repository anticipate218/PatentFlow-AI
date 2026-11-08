import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import worker from './index.ts';
import { checkCode, hasCurrentNotice, issueCookie, session } from './gate.ts';
import { context, environment } from './test-helpers.ts';
import { NOTICE_ACK, NOTICE_SECTIONS, NOTICE_VERSION, REPOSITORY_URL } from '../src/site-info.ts';

beforeEach(t => { (t as TestContext).mock.method(globalThis, 'fetch', async () => { throw new Error('No upstream requests expected'); }); });
async function legacy() {
  const env = environment(); const tag = (await checkCode(env, env.ACCESS_CODES!))!;
  const cookie = (await issueCookie(env, tag)).split(';')[0];
  return { env, tag, cookie };
}
function request(path: string, cookie: string, init: RequestInit = {}) { return new Request('https://app.example.test' + path, { ...init, headers: { Cookie: cookie, ...init.headers } }); }

test('first visit shows the full notice before invitation and a safe GitHub link', async () => {
  const response = await worker.fetch(new Request('https://app.example.test/'), environment(), context());
  const html = await response.text(); assert.equal(response.status, 401);
  for (const section of NOTICE_SECTIONS) assert.ok(html.includes(section.title));
  assert.ok(html.includes(NOTICE_ACK)); assert.ok(html.includes(REPOSITORY_URL));
  assert.match(html, /rel="noopener noreferrer"/); assert.match(html, /name="notice"[^>]+required/);
  assert.ok(html.indexOf('法定责任不因公告而排除') < html.indexOf('id="code"'));
  assert.doesNotMatch(html, /autofocus|checked=/);
});
test('legacy signed sessions retain login but cannot enter assets or APIs before acknowledgement', async () => {
  const { env, cookie, tag } = await legacy();
  assert.equal(await session(request('/', cookie), env), tag); assert.equal(hasCurrentNotice(request('/', cookie)), false);
  for (const path of ['/', '/assets/app.js']) {
    const html = await (await worker.fetch(request(path, cookie), env, context())).text();
    assert.match(html, /你的登录仍然有效/); assert.doesNotMatch(html, /synthetic asset|id="code"/);
  }
  const response = await worker.fetch(request('/api/providers', cookie), env, context());
  assert.equal(response.status, 428); assert.match(await response.text(), /NOTICE_REQUIRED/);
});
test('acknowledgement upgrades the signed session and unlocks normal routes', async () => {
  const { env, cookie } = await legacy();
  const response = await worker.fetch(request('/__notice', cookie, { method: 'POST', body: new URLSearchParams({ notice: NOTICE_VERSION }) }), env, context());
  assert.equal(response.status, 303); const upgraded = response.headers.get('Set-Cookie')!.split(';')[0];
  assert.ok(hasCurrentNotice(request('/', upgraded)));
  assert.equal(await (await worker.fetch(request('/', upgraded), env, context())).text(), 'synthetic asset');
  assert.equal((await worker.fetch(request('/api/providers', upgraded), env, context())).status, 200);
});
test('altering an unacknowledged cookie cannot forge acknowledgement', async () => {
  const { env, cookie } = await legacy(); const parts = cookie.split('.'); parts.splice(2, 0, NOTICE_VERSION);
  const response = await worker.fetch(request('/api/providers', parts.join('.')), env, context());
  assert.equal(response.status, 401);
});

test('a signed acknowledgement of the previous notice cannot admit the new version', async () => {
  const { env, tag } = await legacy();
  const body = tag + '.' + (Math.floor(Date.now() / 1000) + 3600) + '.2026-11-03-v1';
  const signature = createHmac('sha256', env.SESSION_SECRET!).update(body).digest('base64url');
  const cookie = 'pf_session=' + body + '.' + signature;
  assert.equal(await session(request('/', cookie), env), tag);
  assert.equal(hasCurrentNotice(request('/', cookie)), false);
  assert.equal((await worker.fetch(request('/api/providers', cookie), env, context())).status, 428);
  const html = await (await worker.fetch(request('/', cookie), env, context())).text();
  assert.ok(html.includes(NOTICE_VERSION));
  assert.match(html, /免责声明与使用风险提示/);
});
for (const notice of ['', 'outdated-v0']) test('missing or old acknowledgement is not accepted: ' + notice, async () => {
  const { env, cookie } = await legacy();
  const response = await worker.fetch(request('/__notice', cookie, { method: 'POST', body: new URLSearchParams({ notice }) }), env, context());
  assert.equal(response.headers.get('Set-Cookie'), null); assert.match(await response.text(), /请阅读并勾选/);
});
test('notice submissions preserve cross-origin and request size protections', async () => {
  const { env, cookie } = await legacy();
  const foreign = await worker.fetch(request('/__notice', cookie, { method: 'POST', body: new URLSearchParams({ notice: NOTICE_VERSION }), headers: { Origin: 'https://foreign.example' } }), env, context());
  assert.equal(foreign.status, 403);
  const large = await worker.fetch(request('/__notice', cookie, { method: 'POST', body: 'x'.repeat(18000) }), env, context());
  assert.equal(large.status, 413);
});
test('invitation login records explicit notice acknowledgement but never infers it', async () => {
  const env = environment();
  for (const acknowledged of [false, true]) {
    const body = new URLSearchParams({ code: env.ACCESS_CODES!, ...(acknowledged ? { notice: NOTICE_VERSION } : {}) });
    const response = await worker.fetch(new Request('https://app.example.test/__access', { method: 'POST', body }), env, context());
    assert.equal(response.status, 303);
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
    assert.equal(hasCurrentNotice(request('/', cookie)), acknowledged);
  }
});
