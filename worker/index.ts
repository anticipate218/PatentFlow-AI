/**
 * PatentFlow AI on Cloudflare Workers: the built SPA (./dist) plus the /api routes.
 * Administrator keys live in Worker secrets and never reach the browser.
 * BYOK credentials are request-scoped, never saved or mixed into administrator configuration.
 * The /api handlers are the same code the Vite dev server runs (server/agent-routes.ts),
 * reached through a small IncomingMessage/ServerResponse shim.
 */
import { cleanMessages, handleAgentRoute } from "../server/agent-routes.ts";
import { inferVendor, vendorColor } from "../src/vendor.ts";
import { SECURITY, checkCode, clearCookie, gateConfigured, gatePage, hasCurrentNotice, issueCookie, noticePage, publicAccess, redirect, session } from "./gate.ts";
import { NOTICE_VERSION } from '../src/site-info.ts';
import type { GateEnv } from "./gate.ts";
import { RateLimiter } from "./rate-limit.ts";
import { acceptsEventStream, proxyAgentStream } from "./stream-proxy.ts";
import type { RouteStore } from '../server/agent-routes.ts';
import { complete, listModels } from '../server/llm-gateway.ts';
import { byokHosts, parseByok } from './byok.ts';
import type { ByokEnv } from './byok.ts';
import { quotaFetch, quotaLimit, type PublicQuotaEnv } from './public-quota.ts';
export { PublicQuota } from './public-quota.ts';
import { TRAFFIC_EVENT_ID, trafficOptOut, trafficVisitorDigest, type TrafficEnv } from './site-traffic.ts';
export { SiteTraffic } from './site-traffic.ts';

interface Env extends GateEnv, ByokEnv, PublicQuotaEnv, TrafficEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AGNES_API_KEY?: string;
  AGNES_BASE_URL?: string;
  AGNES_MODEL?: string;
  AGNES_WEBSITE?: string;
  AGNES_SECONDARY_API_KEY?: string;
  AGNES_SECONDARY_BASE_URL?: string;
  AGNES_SECONDARY_MODEL?: string;
  AGNES_SECONDARY_STATUS?: string;
  AGNES_SECONDARY_CHECKED_AT?: string;
  ANYSEARCH_API_KEY?: string;
  ANYSEARCH_BASE_URL?: string;
  ANYSEARCH_WEBSITE?: string;
  MAX_BODY_BYTES?: string;
  MAX_OUTPUT_TOKENS?: string;
  AGENT_PER_HOUR?: string;
  TOOLS_PER_HOUR?: string;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const HOUR = 3_600_000;
const limiter = new RateLimiter();
const ROUTES = new Set(["/api/agent", "/api/chat", "/api/search", "/api/extract", "/api/radar/run", '/api/byok/test', '/api/byok/models', '/api/site-models/test']);
const LOCKED = "线上版的模型与密钥由管理员统一配置，不能在这里修改。";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY },
  });
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function outputTokenCap(env: Env): number {
  const value = Number(env.MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value >= 1 ? Math.min(32_000, Math.floor(value)) : 32_000;
}

/** Count actual bytes while reading; Content-Length is only an early rejection hint. */
async function readBody(request: Request, max: number): Promise<Uint8Array | Response> {
  const tooLarge = () => json(413, { error: "内容太大了，请精简后再试。" });
  if (Number(request.headers.get("Content-Length") || 0) > max) {
    void request.body?.cancel().catch(() => {});
    return tooLarge();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        void reader.cancel().catch(() => {});
        return tooLarge();
      }
      if (value.byteLength) chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch {
    return json(400, { error: "请求内容读取失败。" });
  } finally {
    reader.releaseLock();
  }
}

function storeFromEnv(env: Env) {
  return {
    activeModelId: "css-agent",
    providers: [
      {
        id: "css-agent",
        name: "css-agent",
        protocol: "openai" as const,
        role: "model",
        baseUrl: env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1",
        website: env.AGNES_WEBSITE || "https://www.agnes-ai.com/",
        model: env.AGNES_MODEL || "agnes-2.5-flash",
        models: [] as string[],
        secret: env.AGNES_API_KEY || "",
        auth: "bearer" as const,
      },
      {
        id: "anysearch-agent",
        name: "agent",
        protocol: "openai" as const,
        role: "search",
        baseUrl: env.ANYSEARCH_BASE_URL || "https://api.anysearch.com",
        website: env.ANYSEARCH_WEBSITE || "https://www.anysearch.com/",
        model: "",
        models: [] as string[],
        secret: env.ANYSEARCH_API_KEY || "",
        auth: "bearer" as const,
      },
      ...(env.AGNES_SECONDARY_API_KEY ? [{
        id: 'agnes-secondary', name: 'Agnes', protocol: 'openai' as const, role: 'model',
        baseUrl: env.AGNES_SECONDARY_BASE_URL || 'https://apihub.agnes-ai.com/v1', website: 'https://www.agnes-ai.com/',
        model: env.AGNES_SECONDARY_MODEL || 'agnes-2.5-flash', models: [] as string[],
        secret: env.AGNES_SECONDARY_API_KEY, auth: 'bearer' as const,
      }] : []),
    ],
  };
}

/** Same shape the dev server returns, minus anything secret (no key hint, no upstream URL). */
function publicProviders(env: Env) {
  const store = storeFromEnv(env);
  return {
    byok: { enabled: env.BYOK_ENABLED !== 'false', allowedHosts: byokHosts(env) },
    access: { mode: publicAccess(env) ? 'public' : 'invite', dailySharedModelCalls: quotaLimit(env, 'model'), dailySharedSearchCalls: quotaLimit(env, 'search'), resetsAt: '北京时间 00:00' },
    providers: store.providers.map((provider) => {
      const icon = inferVendor(provider as never);
      return {
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        role: provider.role,
        baseUrl: "",
        website: provider.website,
        model: provider.model,
        models: provider.model ? [provider.model] : [],
        icon,
        iconColor: vendorColor(icon),
        hasKey: Boolean(provider.secret),
        keyHint: provider.secret ? "已由管理员在服务端配置" : "未配置密钥",
        active: provider.role === "model" && provider.id === store.activeModelId,
        managed: true,
        available: provider.id !== 'agnes-secondary' || env.AGNES_SECONDARY_STATUS === 'ready',
        availabilityDetail: provider.id === 'agnes-secondary' && env.AGNES_SECONDARY_STATUS !== 'ready'
          ? env.AGNES_SECONDARY_STATUS === 'rate_limited' ? 'Agnes 已配置在服务器，但连续调用出现 429 限流。短连接成功不代表全套生成稳定，目前暂不开放生成；其他模型不受影响。' : 'Agnes 已配置在服务器，待云端验证通过后启用；目前不会切换到此服务。' : '',
        checkedAt: provider.id === 'agnes-secondary' ? env.AGNES_SECONDARY_CHECKED_AT || '' : '',
      };
    }),
  };
}

/** Parse, drop client-chosen provider, cap cost knobs. Null when the body is not a JSON object. */
function sanitize(raw: string, env: Env): string | null {
  let body: Record<string, unknown>;
  try {
    const value = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    body = value as Record<string, unknown>;
  } catch {
    return null;
  }
  delete body.providerId;
  delete body.clientProvider;
  delete body.siteProviderId;
  const cap = (key: string, max: number) => {
    if (typeof body[key] === "number") body[key] = Math.min(Math.max(0, body[key] as number), max);
  };
  const tokens = body.maxTokens;
  body.maxTokens = Math.min(
    typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 1 ? Math.floor(tokens) : 4096,
    outputTokenCap(env),
  );
  cap("maxSteps", 16);
  cap("maxSearches", 12);
  cap("maxResults", 10);
  return JSON.stringify(body);
}

/** Run one existing /api handler against a Web Request body and return its Response (streamed or JSON). */
function runRoute(path: string, bodyText: string, env: Env, ctx: Ctx, requestSignal: AbortSignal, store: RouteStore): Promise<Response> {
  const upstream = quotaFetch(env, store.activeModelId === 'byok' ? undefined : store.providers.find(item => item.id === store.activeModelId)?.secret, env.ANYSEARCH_API_KEY);
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const controller = new AbortController();
  let settle: (response: Response) => void = () => {};
  const ready = new Promise<Response>((resolve) => (settle = resolve));
  let settled = false;
  const resolve = (response: Response) => {
    if (settled) return;
    settled = true;
    settle(response);
  };
  const closeHandlers: Array<() => void> = [];
  const headers = new Headers(SECURITY);
  const res = {
    statusCode: 200,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    flushHeaders() {
      if (!settled) resolve(new Response(readable, { status: res.statusCode, headers }));
    },
    write(chunk: string) {
      if (res.destroyed || res.writableEnded) return false;
      writer.write(enc.encode(chunk)).catch(disconnect);
      return true;
    },
    end() {
      if (res.writableEnded || res.destroyed) return;
      res.writableEnded = true;
      res.flushHeaders();
      writer.close().catch(disconnect);
    },
    on(event: string, fn: () => void) {
      if (event === "close") closeHandlers.push(fn);
      return res;
    },
  };
  function disconnect() {
    if (res.destroyed || res.writableFinished) return;
    res.destroyed = true;
    requestSignal.removeEventListener("abort", disconnect);
    controller.abort();
    for (const fn of closeHandlers) fn();
    void writer.abort().catch(() => {});
    resolve(json(499, { error: "请求已取消。" }));
  }
  // A consumer can cancel while no write is pending. Observe the writer's lifetime too.
  void writer.closed.then(() => {
    res.writableFinished = true;
    requestSignal.removeEventListener("abort", disconnect);
  }, disconnect);
  requestSignal.addEventListener("abort", disconnect, { once: true });
  if (requestSignal.aborted) {
    disconnect();
    return ready;
  }
  const routeCtx = {
    read: () => store,
    write: () => {},
    publicView: () => publicProviders(env),
    readBody: async () => bodyText,
    send: (_res: unknown, status: number, body: unknown) => {
      if (res.destroyed) return;
      res.writableEnded = true;
      res.writableFinished = true;
      requestSignal.removeEventListener("abort", disconnect);
      writer.close().catch(() => {});
      resolve(json(status, body));
    },
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      if ((path === "/api/agent" || path === "/api/chat") && typeof init?.body === "string") {
        const payload = JSON.parse(init.body) as Record<string, unknown>;
        for (const parameter of ['max_tokens', 'max_completion_tokens']) if (typeof payload[parameter] === "number") {
          // Shared routes apply their own defaults/minima, including chat's fixed 4096 tokens.
          // Enforce the deployment's per-call cap after those defaults, at the upstream boundary.
          payload[parameter] = Math.min(payload[parameter] as number, outputTokenCap(env));
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      signal.throwIfAborted();
      return upstream(input, { ...init, signal, redirect: 'manual' });
    }) as typeof fetch,
  };
  const req = { method: "POST", url: path, headers: {} };
  const work = handleAgentRoute(path, req as never, res as never, routeCtx as never).then(
    (handled) => {
      if (!handled) routeCtx.send(res, 404, { error: "没有这个接口。" });
      else res.end();
    },
    (err) => {
      console.error("[agent-route] failed:", err instanceof Error ? err.name : "unknown");
      if (settled) {
        res.write(JSON.stringify({ type: "error", detail: "服务端出错，请稍后重试。", status: 500 }) + "\n");
        res.end();
      } else {
        routeCtx.send(res, 500, { error: "服务端出错，请稍后重试。" });
      }
    },
  );
  ctx.waitUntil(work);
  return ready;
}

async function api(request: Request, path: string, who: string, env: Env, ctx: Ctx): Promise<Response> {
  const method = request.method;
  if (method === "GET" && path === "/api/providers") return json(200, publicProviders(env));
  if (path === "/api/providers/models") return json(200, { ok: false, detail: "线上版的模型列表由管理员维护。", fetched: 0 });
  if (path.startsWith("/api/providers") || path.startsWith("/api/ccswitch")) return json(403, { error: LOCKED });
  if (method !== "POST" || !ROUTES.has(path)) return json(404, { error: "没有这个接口。" });

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: "跨站请求被拒绝。" });

  const heavy = path === "/api/agent" || path === "/api/chat" || path.startsWith('/api/byok/') || path === '/api/site-models/test';
  const limit = heavy ? num(env.AGENT_PER_HOUR, 30) : num(env.TOOLS_PER_HOUR, 120);
  if (!limiter.allow((heavy ? "llm:" : "tool:") + who, limit, HOUR)) return json(429, { error: "调用太频繁了，请稍后再试。" });

  const max = num(env.MAX_BODY_BYTES, 2_000_000);
  const buffer = await readBody(request, max);
  if (buffer instanceof Response) return buffer;
  const raw = new TextDecoder().decode(buffer);
  let selection: unknown;
  let siteProviderId: unknown;
  try {
    const parsed = JSON.parse(raw || '{}') as { clientProvider?: unknown; siteProviderId?: unknown };
    selection = parsed?.clientProvider; siteProviderId = parsed?.siteProviderId;
  } catch { return json(400, { error: '请求格式不对。' }); }
  let store: RouteStore = storeFromEnv(env);
  let effectiveEnv = env;
  if (siteProviderId !== undefined || path === '/api/site-models/test') {
    if (!heavy || selection !== undefined) return json(400, { error: '不能同时指定个人模型和站点模型。' });
    const provider = store.providers.find(item => item.id === siteProviderId && item.role === 'model' && item.secret);
    if (!provider) return json(400, { error: '这个站点模型不存在或尚未配置。' });
    store = { ...store, activeModelId: provider.id };
    if (path === '/api/site-models/test') {
      const started = Date.now();
      const upstream = quotaFetch(env, provider.secret);
      const result = await complete(provider, [{ role: 'user', content: '只回复：连接成功' }], { stream: false, maxTokens: Math.min(512, outputTokenCap(env)), timeoutMs: 45000, signal: request.signal, fetchImpl: (input, init) => upstream(input, { ...init, redirect: 'manual' }) });
      return json(200, { ok: result.ok && Boolean(result.text.trim()), status: result.status, detail: result.ok ? '短连接测试成功，但不代表连续长文或全套生成通过；启用状态仍由管理员决定。' : result.detail, model: provider.model, durationMs: Date.now() - started });
    }
    if (provider.id === 'agnes-secondary' && env.AGNES_SECONDARY_STATUS !== 'ready') return json(503, { error: 'Agnes 暂不可用：最近的云端验证尚未通过。请使用站点默认或个人模型；不会自动替你切换。' });
  }
  if (selection !== undefined || path.startsWith('/api/byok/')) {
    if (!heavy) return json(400, { error: '个人模型配置只能用于模型调用。' });
    const provider = parseByok(selection, env, path === '/api/byok/models');
    if (typeof provider === 'string') return json(400, { error: provider });
    // No administrator model credentials enter this request-scoped store.
    store = { activeModelId: provider.id, providers: [provider, ...store.providers.filter(item => item.role === 'search')] };
    effectiveEnv = { ...env, MAX_OUTPUT_TOKENS: String(Math.min(outputTokenCap(env), provider.maxOutputTokens)) };
    if (path.startsWith('/api/byok/')) {
      const fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'manual' });
      if (path === '/api/byok/models') {
        const result = await listModels(provider, { fetchImpl, signal: request.signal });
        return json(200, { ok: result.ok, detail: result.detail, models: result.models });
      }
      const started = Date.now();
      const result = await complete(provider, [{ role: 'user', content: '只回复：连接成功' }], { stream: false, maxTokens: Math.min(512, provider.maxOutputTokens, outputTokenCap(env)), timeoutMs: 45000, signal: request.signal, fetchImpl });
      return json(200, { ok: result.ok && Boolean(result.text.trim()), status: result.status, detail: result.ok ? '连接成功；仅验证短回答，长文与工具能力请另行测试。' : result.detail, model: provider.model, durationMs: Date.now() - started });
    }
  }
  const body = sanitize(raw, effectiveEnv);
  if (body === null) return json(400, { error: "请求格式不对。" });
  if (path === "/api/agent" && acceptsEventStream(request.headers.get("Accept"))) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.tools === false) {
      const provider = store.providers.find((item) => item.id === store.activeModelId)!;
      return proxyAgentStream({ provider, searchSecret: env.ANYSEARCH_API_KEY, messages: cleanMessages(parsed.messages), maxTokens: parsed.maxTokens as number, signal: request.signal, fetchImpl: quotaFetch(env, provider.id === 'byok' ? undefined : provider.secret) });
    }
  }
  return runRoute(path, body, effectiveEnv, ctx, request.signal, store);
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "local";
}

async function traffic(request: Request, who: string, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json(405, { ok: false, error: '不支持此方法。' });
  if ((request.headers.get('Origin') && request.headers.get('Origin') !== new URL(request.url).origin)
    || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json(403, { ok: false, error: '跨站请求被拒绝。' });
  if (!limiter.allow('traffic:' + clientIp(request), 120, 60_000)) return json(429, { ok: false, error: '统计请求过于频繁，请稍后重试。' });
  let eventId: string | undefined;
  if (request.method === 'POST') {
    const bytes = await readBody(request, 256);
    if (bytes instanceof Response) return bytes;
    const body = JSON.parse(new TextDecoder().decode(bytes) || 'null') as { eventId?: unknown } | null;
    if (typeof body?.eventId !== 'string' || !TRAFFIC_EVENT_ID.test(body.eventId) || Object.keys(body).some(key => key !== 'eventId')) return json(400, { ok: false, error: '统计事件格式不正确。' });
    if (!trafficOptOut(request)) eventId = body.eventId;
  }
  if (!env.SITE_TRAFFIC) return json(503, { ok: false, error: '访问统计暂不可用，不影响其他功能。' });
  const stub = env.SITE_TRAFFIC.get(env.SITE_TRAFFIC.idFromName('site-traffic-v1'));
  const result = await stub.fetch(new Request('https://traffic.internal/' + (eventId ? 'record' : 'summary'), {
    method: eventId ? 'POST' : 'GET', signal: AbortSignal.timeout(3000),
    ...(eventId ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, visitor: await trafficVisitorDigest(env.SESSION_SECRET!, who) }) } : {}),
  }));
  if (!result.ok) return json(503, { ok: false, error: '访问统计暂不可用，不影响其他功能。' });
  return json(200, await result.json());
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!gateConfigured(env)) {
      return new Response(publicAccess(env) ? '站点还没有配置 SESSION_SECRET。' : '站点还没有配置 ACCESS_CODES / SESSION_SECRET。', { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY } });
    }
    if (path === '/api/access' && request.method === 'GET') return json(200, { mode: publicAccess(env) ? 'public' : 'invite', noticeVersion: NOTICE_VERSION, requiresInvite: !publicAccess(env) });

    if (path === "/__access" && request.method === "POST") {
      if (publicAccess(env)) return redirect('/');
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json(403, { error: "跨站请求被拒绝。" });
      if (!limiter.allow("login:" + clientIp(request), 10, 600_000)) return redirect("/?e=2");
      const body = await readBody(request, Math.min(num(env.MAX_BODY_BYTES, 2_000_000), 16_384));
      if (body instanceof Response) return body;
      const form = await new Response(body, { headers: request.headers }).formData().catch(() => null);
      const value = form?.get("code");
      const code = typeof value === "string" ? value : "";
      const tag = code ? await checkCode(env, code) : null;
      if (!tag) return redirect("/?e=1");
      return redirect("/", await issueCookie(env, tag, form?.get('notice') === NOTICE_VERSION));
    }
    if (path === "/__logout") return redirect("/", clearCookie());

    const who = await session(request, env);
    if (path === '/__notice' && request.method === 'POST') {
      if (!who && !publicAccess(env)) return redirect('/');
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json(403, { error: '跨站请求被拒绝。' });
      if (publicAccess(env) && !limiter.allow('notice:' + clientIp(request), 20, 600_000)) return json(429, { error: '请求太频繁，请稍后再试。' });
      const body = await readBody(request, 16_384);
      if (body instanceof Response) return body;
      const form = await new Response(body, { headers: request.headers }).formData().catch(() => null);
      if (form?.get('notice') !== NOTICE_VERSION) return noticePage('3', publicAccess(env));
      const visitor = who || crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      return redirect('/', await issueCookie(env, visitor, true));
    }
    if (!who) {
      if (publicAccess(env)) {
        if (path.startsWith('/api/')) return json(428, { error: '请先阅读并知悉使用公告。无需邀请码。', code: 'NOTICE_REQUIRED', noticeVersion: NOTICE_VERSION });
        return noticePage(null, true);
      }
      if (path.startsWith("/api/")) return json(401, { error: "请先输入邀请码。" });
      return gatePage(url.searchParams.get("e"));
    }
    if (!hasCurrentNotice(request)) {
      if (path.startsWith('/api/')) return json(428, { error: '请刷新页面，阅读并确认当前使用公告后再使用。', code: 'NOTICE_REQUIRED', noticeVersion: NOTICE_VERSION });
      return noticePage(null, publicAccess(env));
    }
    if (path === '/api/traffic') {
      try { return await traffic(request, who, env); }
      catch (error) { return json(error instanceof SyntaxError ? 400 : 503, { ok: false, error: '访问统计暂不可用，不影响其他功能。' }); }
    }
    if (path.startsWith("/api/")) return api(request, path, publicAccess(env) ? 'public-ip:' + clientIp(request) : who, env, ctx);

    const asset = await env.ASSETS.fetch(request);
    const out = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(SECURITY)) out.headers.set(name, value);
    return out;
  },
};
