import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { readCcSwitch, takeCcSwitch } from "./ccswitch-local.ts";
import { parseProviderImport } from "../src/provider-import.ts";
import type { AuthStyle, ProviderProtocol } from "../src/provider-import.ts";
import { inferVendor, vendorColor } from "../src/vendor.ts";
import { handleAgentRoute } from "./agent-routes.ts";

interface StoredProvider {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  role: "model" | "search";
  baseUrl: string;
  website: string;
  model: string;
  models?: string[];
  icon?: string;
  iconColor?: string;
  secret: string;
  auth: AuthStyle;
}

interface Store {
  activeModelId: string;
  providers: StoredProvider[];
}

function loadEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

function hint(secret: string): string {
  if (!secret) return "未配置密钥";
  return `服务端保存 · 末四位 ${secret.slice(-4)}`;
}

function publicView(store: Store) {
  return {
    providers: store.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      role: provider.role,
      baseUrl: provider.baseUrl,
      website: provider.website,
      model: provider.model,
      models: provider.models?.length ? provider.models : provider.model ? [provider.model] : [],
      icon: provider.icon || inferVendor(provider),
      iconColor: provider.iconColor || vendorColor(provider.icon || inferVendor(provider)),
      hasKey: Boolean(provider.secret),
      keyHint: hint(provider.secret),
      active: provider.role === "model" && provider.id === store.activeModelId,
    })),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function chatUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, "");
  if (root.endsWith("/chat/completions")) return root;
  if (root.endsWith("/v1")) return `${root}/chat/completions`;
  return `${root}/v1/chat/completions`;
}

function messagesUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, "");
  if (root.endsWith("/messages")) return root;
  if (root.endsWith("/v1")) return `${root}/messages`;
  return `${root}/v1/messages`;
}

export function credentialApi(root: string): Plugin {
  const file = path.join(root, ".credentials.json");
  const env = { ...loadEnvFile(path.join(root, ".env")), ...loadEnvFile(path.join(root, ".env.local")) };

  const read = (): Store => {
    const fresh = emptyStore();
    if (!fs.existsSync(file)) return applyEnv(fresh, env);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Store;
      if (!Array.isArray(parsed.providers)) return applyEnv(fresh, env);
      return applyEnv(parsed, env);
    } catch {
      return applyEnv(fresh, env);
    }
  };
  const write = (store: Store) => {
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
  };

  return {
    name: "patentflow-credentials",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/api/")) return next();
        if (url === '/api/traffic') {
          send(res, 503, { ok: false, error: '本地 Vite 不累计公开站访问量；可使用 Worker 本地模式测试。' });
          return;
        }
        try {
          if (await handleAgentRoute(url, req, res, { read, write, publicView, readBody, send })) return;
          if (req.method === "GET" && url === "/api/providers") {
            send(res, 200, publicView(read()));
            return;
          }
          if (req.method === "GET" && url === "/api/ccswitch") {
            send(res, 200, readCcSwitch());
            return;
          }
          if (req.method === "POST" && url === "/api/ccswitch/import") {
            const body = JSON.parse(await readBody(req)) as { key?: string; model?: string };
            const entry = takeCcSwitch(body.key || "");
            if (!entry?.canImport) {
              send(res, 400, { error: entry?.reason || "本机 CC Switch 里没有这个可导入的提供方。" });
              return;
            }
            const chosen = body.model && (entry.models.includes(body.model) || body.model === entry.model) ? body.model : entry.model;
            const icon = entry.icon || inferVendor({ name: entry.name, model: chosen, website: entry.website });
            const store = read();
            const id = `cc-${entry.key.replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, "-")}`.slice(0, 72);
            const next: StoredProvider = {
              id,
              name: entry.name,
              protocol: entry.protocol === "claude" ? "claude" : "openai",
              role: "model",
              baseUrl: entry.baseUrl,
              website: entry.website,
              model: chosen,
              models: entry.models.length ? entry.models : chosen ? [chosen] : [],
              icon,
              iconColor: entry.iconColor || vendorColor(icon),
              secret: entry.apiKey,
              auth: entry.auth,
            };
            store.providers = [next, ...store.providers.filter((item) => item.id !== id)];
            store.activeModelId = id;
            write(store);
            send(res, 200, { ...publicView(store), imported: 1 });
            return;
          }
          if (req.method === "POST" && url === "/api/providers") {
            const body = JSON.parse(await readBody(req)) as { name?: string; protocol?: string; baseUrl?: string; model?: string; apiKey?: string };
            const name = (body.name || "").trim();
            const baseUrl = (body.baseUrl || "").trim();
            if (!name || !baseUrl) {
              send(res, 400, { error: "名称和接口地址都要填。" });
              return;
            }
            const protocol = body.protocol === "claude" ? "claude" : "openai";
            const store = read();
            const id = slug(name, protocol);
            const next: StoredProvider = {
              id,
              name,
              protocol,
              role: "model",
              baseUrl,
              website: "",
              model: (body.model || "").trim(),
              secret: (body.apiKey || "").trim() || store.providers.find((item) => item.id === id)?.secret || "",
              auth: protocol === "claude" ? "x-api-key" : "bearer",
            };
            store.providers = [next, ...store.providers.filter((item) => item.id !== id)];
            store.activeModelId = id;
            write(store);
            send(res, 200, publicView(store));
            return;
          }
          if (req.method === "POST" && url === "/api/chat") {
            const body = JSON.parse(await readBody(req)) as { messages?: Array<{ role?: string; content?: string }>; providerId?: string };
            const store = read();
            const provider = store.providers.find((item) => item.id === (body.providerId || store.activeModelId) && item.role === "model");
            if (!provider?.secret) {
              send(res, 409, { ok: false, detail: "当前模型没有服务端密钥。" });
              return;
            }
            const incoming = (body.messages || [])
              .filter((item) => item.content && (item.role === "system" || item.role === "user" || item.role === "assistant"))
              .map((item) => ({ role: item.role as "system" | "user" | "assistant", content: item.content as string }));
            const system = incoming.filter((item) => item.role === "system").slice(-1);
            const dialog = incoming.filter((item) => item.role !== "system").slice(-12);
            const abort = new AbortController();
            req.on("aborted", () => abort.abort());
            const answered = await completeChat(provider, [...system, ...dialog], abort.signal);
            send(res, 200, { ...answered, text: answered.text.split(provider.secret).join("[密钥已隐藏]"), model: provider.model || provider.name });
            return;
          }
          if (req.method === "POST" && url === "/api/providers/import") {
            const body = JSON.parse(await readBody(req)) as { text?: string };
            const imported = parseProviderImport(body.text || "");
            if (imported.error || imported.providers.length === 0) {
              send(res, 400, { error: imported.error || "没有导入任何提供方。" });
              return;
            }
            const store = read();
            let activated = "";
            for (const item of imported.providers) {
              const id = slug(item.name, item.protocol);
              const current = store.providers.find((provider) => provider.id === id);
              const next: StoredProvider = {
                id,
                name: item.name,
                protocol: item.protocol,
                role: "model",
                baseUrl: item.baseUrl || current?.baseUrl || "",
                website: item.website || current?.website || "",
                model: item.model || current?.model || "",
                secret: item.apiKey || current?.secret || "",
                auth: item.auth,
              };
              store.providers = [next, ...store.providers.filter((provider) => provider.id !== id)];
              if (!activated) activated = id;
            }
            if (activated) store.activeModelId = activated;
            write(store);
            send(res, 200, { ...publicView(store), imported: imported.providers.length });
            return;
          }
          if (req.method === "POST" && url === "/api/providers/remove") {
            const body = JSON.parse(await readBody(req)) as { id?: string };
            const store = read();
            const provider = store.providers.find((item) => item.id === body.id);
            if (!provider) {
              send(res, 404, { error: "没有这个提供方。" });
              return;
            }
            store.providers = store.providers.filter((item) => item.id !== provider.id);
            if (store.activeModelId === provider.id) {
              store.activeModelId = store.providers.find((item) => item.role === "model")?.id || "";
            }
            write(store);
            send(res, 200, publicView(store));
            return;
          }
          if (req.method === "POST" && url === "/api/providers/model") {
            const body = JSON.parse(await readBody(req)) as { id?: string; model?: string };
            const store = read();
            const provider = store.providers.find((item) => item.id === body.id && item.role === "model");
            const model = (body.model || "").trim();
            if (!provider || !model) {
              send(res, 404, { error: "没有这个模型。" });
              return;
            }
            provider.model = model;
            provider.models = [...new Set([...(provider.models ?? []), model])];
            store.activeModelId = provider.id;
            write(store);
            send(res, 200, publicView(store));
            return;
          }
          if (req.method === "POST" && url === "/api/providers/activate") {
            const body = JSON.parse(await readBody(req)) as { id?: string };
            const store = read();
            const provider = store.providers.find((item) => item.id === body.id && item.role === "model");
            if (!provider) {
              send(res, 404, { error: "没有这个模型提供方。" });
              return;
            }
            store.activeModelId = provider.id;
            write(store);
            send(res, 200, publicView(store));
            return;
          }
          if (req.method === "POST" && url === "/api/providers/test") {
            const body = JSON.parse(await readBody(req)) as { id?: string };
            const provider = read().providers.find((item) => item.id === body.id);
            if (!provider) {
              send(res, 404, { error: "没有这个提供方。" });
              return;
            }
            send(res, 200, await testProvider(provider));
            return;
          }
          if (req.method === "POST" && url === "/api/search") {
            const body = JSON.parse(await readBody(req)) as { query?: string };
            const provider = read().providers.find((item) => item.role === "search" && item.secret);
            if (!provider) {
              send(res, 409, { error: "AnySearch 密钥还没有放在服务端。" });
              return;
            }
            const query = (body.query || "").trim();
            if (!query) {
              send(res, 400, { error: "检索式是空的。" });
              return;
            }
            const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/search`, {
              method: "POST",
              headers: { Authorization: `Bearer ${provider.secret}`, "Content-Type": "application/json" },
              body: JSON.stringify({ query, max_results: 5, language: "zh-CN" }),
            });
            const payload = (await response.json().catch(() => null)) as { data?: { results?: Array<{ title?: string; url?: string; snippet?: string }> }; results?: Array<{ title?: string; url?: string; snippet?: string }> } | null;
            if (!response.ok) {
              send(res, 200, { ok: false, status: response.status, results: [], detail: "AnySearch 没有返回结果。" });
              return;
            }
            const results = (payload?.data?.results || payload?.results || []).map((item) => ({
              title: item.title || "未命名结果",
              url: item.url || "",
              snippet: item.snippet || "",
            }));
            send(res, 200, { ok: true, status: response.status, results, detail: "这些是网页线索，不是已核验专利文献。" });
            return;
          }
          send(res, 404, { error: "没有这个接口。" });
        } catch {
          send(res, 400, { error: "请求无法处理。" });
        }
      });
    },
  };
}

async function completeChat(provider: StoredProvider, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal?: AbortSignal): Promise<{ ok: boolean; text: string; detail: string }> {
  try {
    if (provider.protocol === "claude") {
      const system = messages.find((item) => item.role === "system")?.content;
      const dialog = messages.filter((item) => item.role !== "system");
      const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
      if (provider.auth === "x-api-key") headers["x-api-key"] = provider.secret;
      else headers.Authorization = `Bearer ${provider.secret}`;
      const response = await fetch(messagesUrl(provider.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: provider.model || "claude-3-5-sonnet-latest",
          max_tokens: 2800,
          system,
          messages: dialog.map((item) => ({ role: item.role, content: item.content })),
        }),
        signal,
      });
      const payload = (await response.json().catch(() => null)) as { content?: Array<{ text?: string }> } | null;
      const text = payload?.content?.map((item) => item.text || "").join("\n") || "";
      return { ok: response.ok && Boolean(text), text, detail: response.ok ? "模型已回复。" : "模型拒绝了这次技能调用。" };
    }
    const response = await fetch(chatUrl(provider.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model || "gpt-4o-mini", messages, max_tokens: 2800 }),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    const text = payload?.choices?.[0]?.message?.content || "";
    return { ok: response.ok && Boolean(text), text, detail: response.ok ? "模型已回复。" : "模型拒绝了这次技能调用。" };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, text: "", detail: "已停止。" };
    }
    return { ok: false, text: "", detail: "服务端没有连上模型。" };
  }
}

function emptyStore(): Store {
  return { activeModelId: "css-agent", providers: [] };
}

function applyEnv(store: Store, env: Record<string, string>): Store {
  const next = { ...store, providers: [...store.providers] };
  upsert(next, {
    id: "css-agent",
    name: "css-agent",
    protocol: "openai",
    role: "model",
    baseUrl: env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1",
    website: env.AGNES_WEBSITE || "https://www.agnes-ai.com/",
    model: env.AGNES_MODEL || "agnes-2.5-flash",
    secret: env.AGNES_API_KEY || next.providers.find((item) => item.id === "css-agent")?.secret || "",
    auth: "bearer",
  });
  upsert(next, {
    id: "anysearch-agent",
    name: "agent",
    protocol: "openai",
    role: "search",
    baseUrl: env.ANYSEARCH_BASE_URL || "https://api.anysearch.com",
    website: env.ANYSEARCH_WEBSITE || "https://www.anysearch.com/",
    model: "",
    secret: env.ANYSEARCH_API_KEY || next.providers.find((item) => item.id === "anysearch-agent")?.secret || "",
    auth: "bearer",
  });
  if (!next.providers.some((item) => item.id === next.activeModelId && item.role === "model")) next.activeModelId = "css-agent";
  return next;
}

function upsert(store: Store, provider: StoredProvider) {
  const index = store.providers.findIndex((item) => item.id === provider.id);
  if (index === -1) store.providers.push(provider);
  else store.providers[index] = { ...store.providers[index], ...provider, secret: provider.secret || store.providers[index].secret };
}

function slug(name: string, protocol: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || protocol;
  return `import-${base}`.slice(0, 48);
}

async function testProvider(provider: StoredProvider): Promise<{ ok: boolean; status: number; detail: string }> {
  if (!provider.secret) return { ok: false, status: 0, detail: "服务端没有这把密钥。" };
  if (!provider.baseUrl) return { ok: false, status: 0, detail: "还没有接口地址。" };
  try {
    if (provider.role === "search") {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "专利", max_results: 1 }),
      });
      return { ok: response.ok, status: response.status, detail: response.ok ? "AnySearch 已响应。" : "AnySearch 拒绝了这次测试。" };
    }
    if (provider.protocol === "claude") {
      const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
      if (provider.auth === "x-api-key") headers["x-api-key"] = provider.secret;
      else headers.Authorization = `Bearer ${provider.secret}`;
      const response = await fetch(messagesUrl(provider.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: provider.model || "claude-3-5-sonnet-latest",
          max_tokens: 16,
          messages: [{ role: "user", content: "回复 OK" }],
        }),
      });
      return { ok: response.ok, status: response.status, detail: response.ok ? "Claude 协议已返回内容。" : "Claude 协议拒绝了这次测试。" };
    }
    const response = await fetch(chatUrl(provider.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model || "gpt-4o-mini",
        messages: [{ role: "user", content: "回复 OK" }],
        max_tokens: 16,
      }),
    });
    return { ok: response.ok, status: response.status, detail: response.ok ? "OpenAI 协议已返回内容。" : "OpenAI 协议拒绝了这次测试。" };
  } catch {
    return { ok: false, status: 0, detail: "服务端没有连上上游。" };
  }
}
