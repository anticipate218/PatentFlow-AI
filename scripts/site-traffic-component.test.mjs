import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
import * as trafficData from '../src/site-traffic-data.ts';

// Exercises the real component's hooks and handlers without a browser or production credentials.
const source = ts.transpileModule(readFileSync(new URL('../src/site-traffic.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));

function harness(fetchImpl) {
  const slots = [], effects = [], timers = new Map(), listeners = new Map();
  let cursor = 0, dirty = true, tree, timerId = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { const value = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(slots[i], value)) { slots[i] = value; dirty = true; } }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, callback }; return slots[i].callback; },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
  };
  const module = { exports: {} };
  runInNewContext(source, {
    exports: module.exports,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
      if (name === './site-traffic-data.ts') return trafficData;
      if (name === './glyph.tsx') return { Glyph: () => null };
      throw new Error('Unexpected import: ' + name);
    },
    fetch: fetchImpl,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000007' },
    navigator: { doNotTrack: '0' },
    window: { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) },
    document: { hidden: false, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
  });
  function render() { cursor = 0; dirty = false; tree = module.exports.SiteTrafficBadge(); while (effects.length) effects.shift()(); }
  return {
    async settle() { for (let i = 0; i < 20; i++) { if (dirty) render(); await setImmediate(); if (!dirty && !effects.length) return; } throw new Error('Unsettled component'); },
    open() { tree.props.children[0].props.onClick(); },
    dialog() { return tree.props.children[1]?.props; },
    midnight() { [...timers.values()][0](); },
  };
}
const snapshot = (day, views) => ({ ok: true, timezone: 'Asia/Shanghai', startedAt: null, total: { views: 10, visitors: 2 }, today: { day, views, visitors: views ? 2 : 0 } });

test('opening the actual traffic component refreshes yesterday through GET only', async () => {
  const methods = [];
  const h = harness(async (_url, init) => { methods.push(init.method); return Response.json(snapshot(methods.length === 1 ? '2026-11-09' : '2026-11-10', methods.length === 1 ? 5 : 0)); });
  await h.settle(); h.open(); await h.settle();
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.deepEqual(h.dialog().data.today, { day: '2026-11-10', views: 0, visitors: 0 });
  h.midnight(); await h.settle(); assert.deepEqual(methods, ['POST', 'GET', 'GET']);
});
test('a late initial POST cannot replace a newer-day GET snapshot', async () => {
  let release;
  const h = harness((_url, init) => init.method === 'POST' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(Response.json(snapshot('2026-11-10', 0))));
  await h.settle(); h.open(); await h.settle();
  release(Response.json(snapshot('2026-11-09', 5))); await h.settle();
  assert.equal(h.dialog().data.today.day, '2026-11-10');
});
test('failed read-only refresh keeps old data explicitly in an error state', async () => {
  const methods = [];
  const h = harness(async (_url, init) => { methods.push(init.method); if (init.method === 'GET') throw new Error('synthetic offline'); return Response.json(snapshot('2026-11-09', 5)); });
  await h.settle(); h.open(); await h.settle();
  assert.equal(h.dialog().error, true); assert.equal(h.dialog().data.today.day, '2026-11-09');
  assert.equal(trafficData.trafficDayLabel(h.dialog().data, Date.parse('2026-11-09T16:00:01Z')), '2026-11-09（历史快照）');
  assert.deepEqual(methods, ['POST', 'GET']);
});
