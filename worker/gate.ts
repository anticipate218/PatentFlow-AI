/**
 * Invite-code gate for the whole site. A valid code earns an HMAC-signed, HttpOnly session cookie.
 * Removing a code from ACCESS_CODES revokes every session issued for it.
 */
import { GITHUB_MARK_PATH, NOTICE_ACK, NOTICE_SECTIONS, NOTICE_SUMMARY, NOTICE_TITLE, NOTICE_VERSION, REPOSITORY_URL } from '../src/site-info.ts';
import { noticeEntryScript } from '../src/notice-entry.ts';
export interface GateEnv {
  ACCESS_MODE?: string;
  ACCESS_CODES?: string;
  SESSION_SECRET?: string;
  SESSION_DAYS?: string;
}

export function publicAccess(env: GateEnv): boolean { return env.ACCESS_MODE === 'public'; }

const COOKIE = "pf_session";
const enc = new TextEncoder();
export const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function b64url(bytes: ArrayBuffer): string {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function label(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode("pf-code:" + code));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let cache: { raw: string; codes: Map<string, string> } | null = null;

function configuredCodes(env: GateEnv): string[] {
  return (env.ACCESS_CODES || "").split(/[\s,]+/).filter(Boolean);
}

async function codes(env: GateEnv): Promise<Map<string, string>> {
  const raw = env.ACCESS_CODES || "";
  if (cache && cache.raw === raw) return cache.codes;
  const map = new Map<string, string>();
  for (const code of configuredCodes(env)) {
    map.set(await label(code), code);
  }
  cache = { raw, codes: map };
  return map;
}

export function gateConfigured(env: GateEnv): boolean {
  if (publicAccess(env)) return Boolean(env.SESSION_SECRET && env.SESSION_SECRET.trim().length >= 32);
  const entries = configuredCodes(env);
  // Reject the entire configuration instead of silently discarding malformed invite codes.
  return Boolean(env.SESSION_SECRET && env.SESSION_SECRET.trim().length >= 32)
    && entries.length > 0 && entries.every((code) => code.length >= 6 && code.length <= 200);
}

/** Returns the code's label when the code is valid, else null. */
export async function checkCode(env: GateEnv, input: string): Promise<string | null> {
  if (publicAccess(env)) return null;
  if (!gateConfigured(env)) return null;
  const code = input.trim();
  if (code.length < 6 || code.length > 200) return null;
  const tag = await label(code);
  const stored = (await codes(env)).get(tag);
  return stored && same(stored, code) ? tag : null;
}

export async function issueCookie(env: GateEnv, tag: string, acknowledged = false): Promise<string> {
  if (!gateConfigured(env)) throw new Error("Invalid access gate configuration");
  const days = Math.min(Math.max(Number(env.SESSION_DAYS) || 7, 1), 30);
  const maxAge = Math.floor(days * 86400);
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const body = (publicAccess(env) ? 'p.' : '') + tag + "." + exp + (acknowledged ? '.' + NOTICE_VERSION : '');
  const sig = await hmac(env.SESSION_SECRET || "", body);
  return COOKIE + "=" + body + "." + sig + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

export function clearCookie(): string {
  return COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function cookieParts(request: Request) {
  return (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pf_session=(p\.)?([a-f0-9]{12})\.(\d{10})(?:\.([A-Za-z0-9-]{1,40}))?\.([A-Za-z0-9_-]{43})(?:;|$)/);
}

/** Call only after session() has authenticated this same request. */
export function hasCurrentNotice(request: Request): boolean {
  return cookieParts(request)?.[4] === NOTICE_VERSION;
}

/** Legacy sessions remain authenticated but must read the current notice before admission. */
export async function session(request: Request, env: GateEnv): Promise<string | null> {
  if (!gateConfigured(env)) return null;
  const match = cookieParts(request);
  if (!match) return null;
  const [, scope, tag, exp, notice, sig] = match;
  if (Boolean(scope) !== publicAccess(env)) return null;
  if (Number(exp) * 1000 <= Date.now()) return null;
  if (!same(await hmac(env.SESSION_SECRET || "", (scope || '') + tag + "." + exp + (notice ? '.' + notice : '')), sig)) return null;
  if (!publicAccess(env) && !(await codes(env)).has(tag)) return null;
  return tag;
}

export function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", ...SECURITY });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function gatePage(error: string | null): Response {
  return entryPage(true, error);
}

export function noticePage(error: string | null = null, open = false): Response { return entryPage(false, error, open); }

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); }

function entryPage(needsCode: boolean, error: string | null, open = false): Response {
  const msg = error === '1' ? '邀请码不对，请检查后重试。' : error === '2' ? '尝试次数太多，请 10 分钟后再试。' : error === '3' ? '请阅读并勾选知悉使用公告，再进入测试站。' : '';
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PatentFlow AI · 使用公告</title><meta name="robots" content="noindex"><style>',
    '*{box-sizing:border-box}body{margin:0;padding:30px 16px;background:radial-gradient(at 10% 0%,#eaf0ff,transparent 55%),#f6f8fc;color:#263650;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{max-width:780px;margin:0 auto;background:#fff;border:1px solid #e0e8f5;border-radius:22px;padding:30px;box-shadow:0 20px 65px #203b6810}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.brand{font-size:19px;font-weight:750}.github{display:inline-flex;align-items:center;gap:7px;background:#172436;color:white;text-decoration:none;border-radius:10px;padding:9px 12px;font-size:13px}h1{font-size:25px;margin:22px 0 8px}.subtitle{color:#6a7990;font-size:13px}.summary{background:#fff6e3;color:#805614;border-left:3px solid #dda43d;padding:13px 16px;border-radius:7px;font-size:15px;font-weight:650}h2{font-size:14px;margin:19px 0 5px}section p{font-size:13px;line-height:1.8;color:#56667d;margin:0}form{border-top:1px solid #e5ebf5;margin-top:22px;padding-top:19px}label{font-size:13px;line-height:1.7}input[type=password]{width:100%;margin:7px 0 14px;padding:11px 12px;font:inherit;border:1px solid #cbd8eb;border-radius:9px}.ack{display:flex;align-items:flex-start;gap:9px}.ack input{flex:none;margin:4px 0 0;width:16px;height:16px}button{width:100%;margin-top:15px;padding:12px;border:0;border-radius:10px;background:#1765ec;color:#fff;font-size:14px;font-weight:650;cursor:pointer}button:hover{background:#104ec1}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #8aaff4;outline-offset:3px}.err{color:#a83030;font-size:13px;margin:12px 0}.foot{font-size:11px;color:#7b899c;line-height:1.6;margin-top:13px}@media(max-width:520px){body{padding:12px}main{padding:20px;border-radius:15px}h1{font-size:22px}.brand{font-size:16px}.github{padding:8px}}',
    '</style></head><body><main><div class="top"><span class="brand">PatentFlow AI</span><a class="github" href="' + REPOSITORY_URL + '" target="_blank" rel="noopener noreferrer" aria-label="GitHub 开源仓库（新标签页）"><svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="' + GITHUB_MARK_PATH + '"/></svg>GitHub ↗</a></div>',
    '<h1>' + NOTICE_TITLE + '</h1><p class="subtitle">' + (open ? '公开体验版 · 无需邀请码或注册，阅读并知悉公告后即可开始。共享服务有使用限额，也可配置自己的模型 Key。' : '邀请测试版 · ' + (needsCode ? '请先阅读公告，再输入邀请码进入。' : '你的登录仍然有效，请先知悉当前公告再继续使用。')) + '</p><p class="summary">' + NOTICE_SUMMARY + '</p>',
    NOTICE_SECTIONS.map(section => '<section><h2>' + escapeHtml(section.title) + '</h2><p>' + escapeHtml(section.text) + '</p></section>').join(''),
    '<form method="post" action="' + (needsCode ? '/__access' : '/__notice') + '">',
    needsCode ? '<label for="code">邀请码</label><input id="code" name="code" type="password" autocomplete="off" placeholder="请输入邀请码" required maxlength="200">' : '',
    '<label class="ack"><input type="checkbox" name="notice" value="' + NOTICE_VERSION + '" required><span>' + NOTICE_ACK + '</span></label>',
    msg ? '<p class="err" role="alert">' + msg + '</p>' : '',
    '<button type="submit">知悉风险并进入测试站</button><p class="foot">每次打开或刷新均需重新确认；站内切换功能不重复提示。不希望继续使用时，可关闭本页面。公告版本：' + NOTICE_VERSION + ' · 工作台顶部可随时重读。</p></form></main><script>' + noticeEntryScript() + '</script></body></html>',
  ].join('');
  return new Response(html, { status: needsCode ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY } });
}
