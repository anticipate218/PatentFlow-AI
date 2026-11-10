// Low-traffic availability checks: no model calls, no secrets file and no traffic POSTs.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseTrafficSnapshot } from '../src/site-traffic-data.ts';

export async function runSiteHealth({ base = 'https://patentflow-ai.patentflow-ai.workers.dev', fetchImpl = fetch } = {}) {
  const root = new URL(base);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password) throw new Error('Invalid health-check URL');
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); return Boolean(ok); };
  const result = () => ({ ok: checks.every(item => item.ok), checkedAt: new Date().toISOString(), checks });
  async function request(route, init = {}) {
    return fetchImpl(new URL(route, root), { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  }
  async function text(response) {
    if (Number(response.headers.get('content-length') || 0) > 3_000_000) { await response.body?.cancel(); throw new Error('Oversized response'); }
    if (!response.body) return '';
    const reader = response.body.getReader(); const parts = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 3_000_000) { await reader.cancel(); throw new Error('Oversized response'); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    const joined = new Uint8Array(size); let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
    return new TextDecoder().decode(joined);
  }
  try {
    const access = await request('/api/access'); const meta = JSON.parse(await text(access));
    if (!check('public access metadata', access.status === 200 && meta.mode === 'public' && meta.requiresInvite === false && /^[A-Za-z0-9-]{1,40}$/.test(meta.noticeVersion ?? ''))) return result();
    const landing = await request('/');
    check('disclaimer landing', landing.status === 200 && /免责声明|使用公告/.test(await text(landing)));
    const blocked = await request('/api/providers');
    check('unacknowledged API remains protected', blocked.status === 428); await text(blocked);
    const admission = await request('/__notice', { method: 'POST', headers: { Origin: root.origin }, body: new URLSearchParams({ notice: meta.noticeVersion }) });
    const session = admission.headers.get('set-cookie') ?? '';
    if (!check('current disclaimer admission', admission.status === 303 && session.startsWith('pf_session=') && /HttpOnly/i.test(session) && /Secure/i.test(session))) return result();
    const headers = { Cookie: session.split(';')[0] };
    const page = await request('/', { headers }); const html = await text(page);
    check('workspace HTML', page.status === 200 && /id=["']root["']/.test(html));
    const tag = [...html.matchAll(/<script\b[^>]*>/gi)].find(([value]) => /type=["']module["']/.test(value))?.[0] ?? '';
    const src = /\bsrc=["']([^"']+)["']/.exec(tag)?.[1];
    const entry = src ? new URL(src, root) : null;
    if (check('same-origin entry asset', entry?.origin === root.origin && entry.pathname.startsWith('/assets/') && /\.m?js$/.test(entry.pathname))) {
      const asset = await request(entry.href, { headers }); const content = await text(asset);
      check('entry JavaScript served, not fallback HTML', asset.status === 200 && /javascript|ecmascript/i.test(asset.headers.get('content-type') ?? '') && content.length > 0 && !/^\s*<!doctype|^\s*<html/i.test(content));
    }
    const providers = await request('/api/providers', { headers }); const providerText = await text(providers);
    const privateToken = /\b(?:sk-[A-Za-z0-9_-]{20,}|as_sk_[A-Za-z0-9_-]{24,}|gh[opusr]_[A-Za-z0-9]{30,})\b/;
    check('provider metadata without tokens', providers.status === 200 && Array.isArray(JSON.parse(providerText).providers) && !privateToken.test(providerText));
    const traffic = await request('/api/traffic', { headers });
    const snapshot = parseTrafficSnapshot(JSON.parse(await text(traffic)));
    check('read-only traffic statistics', traffic.status === 200 && snapshot.ok);
  } catch {
    // Never print exception messages, response bodies, headers, cookies or credentials.
    check('bounded request/response checks', false);
  }
  return result();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await runSiteHealth({ base: process.env.BASE });
    for (const item of report.checks) console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name);
    console.log(report.checks.filter(item => item.ok).length + '/' + report.checks.length + ' health checks passed');
    process.exitCode = report.ok ? 0 : 1;
  } catch { console.error('Health check configuration failed; no private data was printed.'); process.exitCode = 1; }
}
