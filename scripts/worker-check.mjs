// Isolated, offline-upstream workerd check: node scripts/worker-check.mjs
// Requires npm ci (Node 24+). Assets are a routing fixture; the production SPA build is checked separately.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { NOTICE_VERSION } from '../src/site-info.ts';
import { assertPortFree, waitForPortsFree } from './worker-ports.mjs';

const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = path.join(root, ".tmp-library", "worker-mock");
const assets = path.join(workspace, "assets");
const base = "http://127.0.0.1:8877";
const mockBase = "http://127.0.0.1:8879";
const inspectorPort = 8878;
const runState = path.join(workspace, 'state-' + Date.now());
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const vars = {
  ACCESS_CODES: "synthetic-worker-ci-invite",
  SESSION_SECRET: "synthetic-worker-ci-session-secret-only-123456789",
  AGNES_API_KEY: "mock-model-key",
  AGNES_BASE_URL: mockBase + "/v1",
  AGNES_MODEL: "mock-model",
  AGNES_WEBSITE: "https://model.example.test",
  ANYSEARCH_API_KEY: "mock-search-key",
  ANYSEARCH_BASE_URL: mockBase + "/v1",
  ANYSEARCH_WEBSITE: "https://search.example.test",
  AGENT_PER_HOUR: "8",
};
const secrets = [vars.ACCESS_CODES, vars.SESSION_SECRET, vars.AGNES_API_KEY, vars.ANYSEARCH_API_KEY];
const redact = (text) => secrets.reduce((out, secret) => out.split(secret).join("[REDACTED]"), String(text));
const shutdown = new AbortController();
const onSignal = () => shutdown.abort(new Error("Worker check interrupted"));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
const children = new Set();

// Do not inherit provider keys, NODE_OPTIONS, proxy settings, or Cloudflare credentials from the caller.
const inherited = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"]);
const childEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.has(name.toUpperCase()))),
  HOME: path.join(workspace, "home"),
  USERPROFILE: path.join(workspace, "home"),
  APPDATA: path.join(workspace, "config"),
  LOCALAPPDATA: path.join(workspace, "cache"),
  XDG_CONFIG_HOME: path.join(workspace, "config"),
  XDG_CACHE_HOME: path.join(workspace, "cache"),
  CI: "true",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: path.join(workspace, "wrangler.log"),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
};

function launch(label, args, extraEnv = {}) {
  shutdown.signal.throwIfAborted();
  const child = spawn(process.execPath, args, {
    cwd: workspace, env: { ...childEnv, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  const item = { label, child, output: "", finished: false, stopped: false, error: null, done: null };
  const collect = (chunk) => { item.output = (item.output + chunk.toString()).slice(-32_768); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => { item.error = error; });
  item.done = new Promise((resolve) => child.once("close", (code, signal) => {
    item.finished = true;
    resolve({ code, signal });
  }));
  children.add(item);
  return item;
}

async function stop(item) {
  if (!item || item.stopped || !item.child.pid) return;
  item.stopped = true;
  if (process.platform === "win32") {
    if (!item.finished) {
      // Restrict Windows tree cleanup to this exact spawned PID, never a process name or port owner.
      const killer = spawn("taskkill.exe", ["/PID", String(item.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((resolve) => {
        const timer = setTimeout(() => { killer.kill(); resolve(); }, 5000);
        const done = () => { clearTimeout(timer); resolve(); };
        killer.once("error", done);
        killer.once("close", done);
      });
      if (!item.finished) item.child.kill();
    }
  } else {
    // Each child owns a fresh process group, including Wrangler's workerd descendants.
    try { process.kill(-item.child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await Promise.race([item.done, delay(1000)]);
    try { process.kill(-item.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await Promise.race([item.done, delay(3000)]);
}

async function request(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]) });
}

async function waitReady(item, url, expectedStatus) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    if (item.finished || item.error) throw new Error(`${item.label} exited before readiness: ${item.error?.message || "see diagnostic output"}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(750)]) });
      await response.arrayBuffer();
      if (response.status === expectedStatus) return;
    } catch { /* The listener may not be available yet. */ }
    await delay(200, undefined, { signal: shutdown.signal });
  }
  throw new Error(`${item.label} did not become ready within 60 seconds`);
}

async function configure(name, bindings) {
  const varsFile = path.join(workspace, `${name}.vars`);
  const configFile = path.join(workspace, `${name}.json`);
  await writeFile(varsFile, Object.entries(bindings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n");
  await writeFile(configFile, JSON.stringify({
    name: "patentflow-worker-mock-check",
    main: path.join(root, "worker", "index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    assets: { directory: assets, binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true },
    durable_objects: { bindings: [{ name: 'PUBLIC_QUOTA', class_name: 'PublicQuota' }] },
    migrations: [{ tag: 'public-quota-v1', new_sqlite_classes: ['PublicQuota'] }],
    vars: bindings,
  }, null, 2) + "\n");
  return { varsFile, configFile };
}

async function startWorker(config) {
  const item = launch("wrangler", [wrangler, "dev", "--local", "--config", config.configFile,
    "--env-file", config.varsFile, "--ip", "127.0.0.1", "--port", "8877",
    "--inspector-port", String(inspectorPort), "--persist-to", runState, "--log-level", "warn"]);
  await waitReady(item, base + "/api/access", 200);
  return item;
}

async function login() {
  const response = await request(base + "/__access", { method: "POST", redirect: "manual", body: new URLSearchParams({ code: vars.ACCESS_CODES, notice: NOTICE_VERSION }) });
  assert.equal(response.status, 303);
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.startsWith("pf_session="));
  return { Cookie: cookie, "Content-Type": "application/json" };
}

async function run() {
  await access(wrangler);
  await Promise.all([8877, inspectorPort, 8879].map(assertPortFree));
  await mkdir(assets, { recursive: true });
  await mkdir(childEnv.HOME, { recursive: true });
  await writeFile(path.join(assets, "index.html"), '<!doctype html><html><head><title>Worker routing fixture</title></head><body><div id="root">Synthetic SPA fixture</div></body></html>');
  const config = await configure("mock", vars);
  const noKeys = await configure("no-keys", { ...vars, AGNES_API_KEY: "", ANYSEARCH_API_KEY: "" });
  const mock = launch("mock upstream", [path.join(root, "scripts", "mock-llm.mjs")], { MOCK_PORT: "8879" });
  await waitReady(mock, mockBase + "/__seen", 200);
  const worker = await startWorker(config);
  console.log("Mock Worker ready on 8877; upstream 8879; inspector 8878.");
  const smoke = launch("Worker smoke", [path.join(root, "scripts", "worker-smoke.mjs")], {
    BASE: base, MOCK: "1", MOCK_BASE: mockBase, CODE: vars.ACCESS_CODES, VARS_FILE: config.varsFile,
  });
  const timeout = new AbortController();
  let result;
  try {
    result = await Promise.race([smoke.done, delay(60_000, undefined, { signal: AbortSignal.any([shutdown.signal, timeout.signal]) })
      .then(() => { throw new Error("Worker smoke exceeded 60 seconds"); })]);
  } finally { timeout.abort(); }
  console.log(redact(smoke.output).trim());
  assert.equal(result.code, 0, "Worker smoke failed");

  const headers = await login();
  const extracted = await request(base + "/api/extract", { method: "POST", headers, body: JSON.stringify({ url: "https://example.com/a" }) });
  const body = await extracted.json();
  assert.equal(extracted.status, 200);
  assert.equal(body.ok, true, "extraction must return a successful document, not search results");
  assert.equal(body.url, "https://example.com/a");
  assert.equal(body.title, "模拟提取页面");
  assert.equal(body.content, "模拟网页正文，仅用于 Worker 运行时测试。");
  assert.ok(!secrets.some((secret) => JSON.stringify(body).includes(secret)));
  console.log("PASS Worker extraction returns the expected document without credentials");
  const anonymous = await request(mockBase + "/v1/extract", { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401);
  await anonymous.text();
  console.log("PASS mock upstream refuses missing authentication");

  await stop(worker);
  await waitForPortsFree([8877, inspectorPort], { signal: shutdown.signal });
  const noKeyWorker = await startWorker(noKeys);
  const noKeyHeaders = await login();
  const before = await (await request(mockBase + "/__seen")).json();
  for (const route of ["chat", "agent", "search", "extract"]) {
    const response = await request(`${base}/api/${route}`, { method: "POST", headers: noKeyHeaders, body: JSON.stringify({
      messages: [{ role: "user", content: "synthetic question" }], query: "synthetic", url: "https://example.com/a",
    }) });
    const reply = await response.json();
    assert.equal(response.status, 409, `${route} must report missing server credentials`);
    assert.ok(reply.error || reply.detail);
    console.log(`PASS Worker /api/${route} returns 409 without configured keys`);
  }
  const after = await (await request(mockBase + "/__seen")).json();
  assert.equal(after.length, before.length, "missing-key routes must not call upstream");
  console.log("PASS missing-key routes made no upstream requests");
  await stop(noKeyWorker);
  await waitForPortsFree([8877, inspectorPort], { signal: shutdown.signal });
  const publicConfig = await configure('public', { ...vars, ACCESS_MODE: 'public', ACCESS_CODES: '', PUBLIC_DAILY_MODEL_CALLS: '1', PUBLIC_DAILY_SEARCH_CALLS: '1', AGENT_PER_HOUR: '100' });
  const publicWorker = await startWorker(publicConfig);
  const landing = await request(base + '/'); const landingText = await landing.text();
  assert.equal(landing.status, 200); assert.ok(landingText.includes('无需邀请码')); assert.ok(!landingText.includes('name="code"'));
  console.log('PASS public landing needs no invitation code');
  const admitted = await request(base + '/__notice', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ notice: NOTICE_VERSION }) });
  const publicCookie = (admitted.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(publicCookie.startsWith('pf_session=p.'));
  const publicHeaders = { Cookie: publicCookie, 'Content-Type': 'application/json' };
  console.log('PASS public notice admits an anonymous visitor');
  const firstModel = await request(base + '/api/chat', { method: 'POST', headers: publicHeaders, body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic budget test' }] }) });
  assert.equal((await firstModel.json()).ok, true);
  const secondModel = await request(base + '/api/agent', { method: 'POST', headers: { ...publicHeaders, Accept: 'text/event-stream' }, body: JSON.stringify({ tools: false, messages: [{ role: 'user', content: 'synthetic budget test' }] }) });
  assert.equal(secondModel.status, 429); assert.match(await secondModel.text(), /今日共享模型/);
  console.log('PASS durable shared model cap applies across chat and SSE');
  const firstSearch = await request(base + '/api/search', { method: 'POST', headers: publicHeaders, body: JSON.stringify({ query: 'synthetic patent' }) });
  assert.equal((await firstSearch.json()).ok, true);
  const secondSearch = await request(base + '/api/extract', { method: 'POST', headers: publicHeaders, body: JSON.stringify({ url: 'https://example.com/a' }) });
  const searchDenied = await secondSearch.json(); assert.equal(searchDenied.ok, false); assert.match(searchDenied.detail, /今日共享检索/);
  console.log('PASS durable shared search cap includes page extraction');
  assert.equal((await request(base + '/', { headers: publicHeaders })).status, 200);
  console.log('PASS exhausted shared quota does not block page access');
  await stop(publicWorker);
  await waitForPortsFree([8877, inspectorPort], { signal: shutdown.signal });
  await startWorker(publicConfig);
  const afterRestart = await request(base + '/api/chat', { method: 'POST', headers: publicHeaders, body: JSON.stringify({ messages: [{ role: 'user', content: 'restart cannot reset usage' }] }) });
  const restartDenied = await afterRestart.json(); assert.equal(restartDenied.ok, false); assert.match(restartDenied.detail, /今日共享模型/);
  console.log('PASS durable quota survives restarting the Worker runtime');
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  console.error("FAIL " + redact(error.message));
  for (const item of children) {
    if (item.label !== "Worker smoke" && item.output.trim()) console.error(`[${item.label}] ${redact(item.output).slice(-6000)}`);
  }
} finally {
  const results = await Promise.allSettled([...children].reverse().map(stop));
  for (const result of results) {
    if (result.status === "rejected") { process.exitCode = 1; console.error("Cleanup failed: " + redact(result.reason)); }
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
if (!process.exitCode) console.log("Worker mock runtime check passed; spawned processes stopped.");
