/**
 * AnySearch REST client (https://www.anysearch.com/docs/api-endpoints).
 *
 * POST /v1/search  { query, max_results 1-10, tag?, zone? cn|intl, language?, params?, format? }
 * POST /v1/extract { url }  (strict body: exactly one field)
 * Both reply { code: 0, message, request_id, data }.
 *
 * Results are web leads, never verified patent documents. Extracted page text is untrusted input.
 * A 402 for anonymous callers can carry generated credentials, so upstream 402 messages are never surfaced.
 */
import { redact } from "./llm-gateway.ts";

export interface SearchConfig {
  baseUrl: string;
  secret: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  content: string;
}

export interface SearchInput {
  query: string;
  maxResults?: number;
  zone?: "cn" | "intl";
  language?: string;
  tag?: string;
  format?: "json" | "markdown";
}

export interface SearchOutcome {
  ok: boolean;
  status: number;
  requestId: string;
  results: SearchHit[];
  detail: string;
  tookMs: number;
}

export interface ExtractOutcome {
  ok: boolean;
  status: number;
  requestId: string;
  url: string;
  title: string;
  content: string;
  detail: string;
}

interface CallOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const ANYSEARCH_BASE = "https://api.anysearch.com";

export function anyEndpoint(baseUrl: string, path: "search" | "extract"): string {
  const root = (baseUrl || ANYSEARCH_BASE)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1(\/(search|extract|sub-domains))?$/, "");
  return `${root}/v1/${path}`;
}

export function describeSearchStatus(status: number, path: "search" | "extract"): string {
  switch (status) {
    case 400:
      return path === "extract" ? "网址无效" : "检索式无效或为空";
    case 401:
      return "AnySearch 密钥无效";
    case 402:
      return "AnySearch 额度已用完";
    case 403:
      return "AnySearch 密钥过期或账号被停用";
    case 415:
      return "AnySearch 不接受这个请求格式";
    case 422:
      return "这个网址抽不出正文";
    case 429:
      return "AnySearch 限流，请稍后再试";
    case 502:
      return "AnySearch 搜索服务暂不可用";
    default:
      if (status >= 500) return "AnySearch 服务故障";
      return status ? `AnySearch 返回 ${status}` : "没有连上 AnySearch";
  }
}

function privateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

/** Only public absolute http(s) URLs may be handed to the extractor. */
export function isPublicHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || (!host.includes(".") && !host.includes(":"))) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false;
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("::ffff:")) return false;
    return true;
  }
  return !privateIpv4(host);
}

function clip(text: string, cap: number): string {
  const value = text.replace(/\s+\n/g, "\n").trim();
  return value.length <= cap ? value : `${value.slice(0, cap)}…`;
}

async function call(cfg: SearchConfig, path: "search" | "extract", payload: Json, options: CallOptions): Promise<{ status: number; body: Json | null; requestId: string; tookMs: number; failure: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (cfg.secret) headers.Authorization = `Bearer ${cfg.secret}`;
  const started = Date.now();
  try {
    const response = await fetchImpl(anyEndpoint(cfg.baseUrl, path), { method: "POST", headers, body: JSON.stringify(payload), signal });
    const raw = await response.text();
    let body: Json | null = null;
    try {
      const value = JSON.parse(raw) as unknown;
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
    } catch {
      body = null;
    }
    const requestId = typeof body?.request_id === "string" ? body.request_id : "";
    if (!response.ok || (typeof body?.code === "number" && body.code !== 0)) {
      const status = response.ok ? 502 : response.status;
      const upstream = status === 402 || typeof body?.message !== "string" ? "" : redact(body.message, [cfg.secret]);
      const detail = `${describeSearchStatus(status, path)}${upstream && !/^success$/i.test(upstream) ? `：${clip(upstream, 160)}` : ""}`;
      return { status, body: null, requestId, tookMs: Date.now() - started, failure: detail };
    }
    return { status: response.status, body, requestId, tookMs: Date.now() - started, failure: "" };
  } catch (error) {
    const tookMs = Date.now() - started;
    if (options.signal?.aborted) return { status: 0, body: null, requestId: "", tookMs, failure: "已停止。" };
    if (error instanceof Error && error.name === "TimeoutError") return { status: 408, body: null, requestId: "", tookMs, failure: "AnySearch 响应超时。" };
    return { status: 0, body: null, requestId: "", tookMs, failure: "没有连上 AnySearch。" };
  }
}

export async function anySearch(cfg: SearchConfig, input: SearchInput, options: CallOptions = {}): Promise<SearchOutcome> {
  const query = input.query.trim();
  if (!query) return { ok: false, status: 400, requestId: "", results: [], detail: "检索式是空的。", tookMs: 0 };
  const payload: Json = { query: query.slice(0, 400), max_results: Math.min(10, Math.max(1, Math.round(input.maxResults ?? 8))) };
  if (input.zone) payload.zone = input.zone;
  if (input.language) payload.language = input.language;
  if (input.tag) payload.tag = input.tag;
  if (input.format) payload.format = input.format;
  const answer = await call(cfg, "search", payload, options);
  if (answer.failure) return { ok: false, status: answer.status, requestId: answer.requestId, results: [], detail: answer.failure, tookMs: answer.tookMs };
  const data = ((answer.body?.data ?? answer.body ?? {}) as Json) || {};
  const list = Array.isArray(data.results) ? data.results : [];
  const results = list
    .filter(isJson)
    .map((item) => ({
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : "未命名结果",
      url: typeof item.url === "string" && isPublicHttpUrl(item.url.trim()) ? item.url.trim() : "",
      snippet: typeof item.snippet === "string" ? item.snippet.trim() : "",
      content: typeof item.content === "string" ? item.content.trim() : "",
    }))
    .filter((item) => item.url || item.snippet || item.content);
  return {
    ok: true,
    status: answer.status,
    requestId: answer.requestId,
    results,
    detail: results.length ? `${results.length} 条网页线索，不是已核验的专利文献。` : "没有检到结果，换个说法再试。",
    tookMs: answer.tookMs,
  };
}

export async function anyExtract(cfg: SearchConfig, url: string, options: CallOptions = {}): Promise<ExtractOutcome> {
  const target = url.trim();
  if (!isPublicHttpUrl(target)) return { ok: false, status: 400, requestId: "", url: target, title: "", content: "", detail: "只能读取公开的 http(s) 网址。" };
  const answer = await call(cfg, "extract", { url: target }, { timeoutMs: 45_000, ...options });
  if (answer.failure) return { ok: false, status: answer.status, requestId: answer.requestId, url: target, title: "", content: "", detail: answer.failure };
  const data = ((answer.body?.data ?? {}) as Json) || {};
  const content = typeof data.content === "string" ? data.content.trim() : "";
  const responseUrl = typeof data.url === "string" && isPublicHttpUrl(data.url.trim()) ? data.url.trim() : target;
  return {
    ok: Boolean(content),
    status: answer.status,
    requestId: answer.requestId,
    url: responseUrl,
    title: typeof data.title === "string" ? data.title.trim() : "",
    content,
    detail: content ? `读到 ${content.length} 字，外部内容仅作线索。` : "这个网址没有可读正文。",
  };
}
