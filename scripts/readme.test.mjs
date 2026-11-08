import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('README prominently links the public demo and keeps local documentation links valid', () => {
  const text = fs.readFileSync('README.md', 'utf8');
  assert.ok(text.slice(0, 700).includes('https://patentflow-ai.patentflow-ai.workers.dev/'));
  assert.ok(text.slice(0, 700).includes('无需邀请码'));
  assert.doesNotMatch(text, /需要维护者提供的邀请码|在线邀请测试/);
  for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) if (!/^(?:https?:|#)/.test(target)) assert.ok(fs.existsSync(path.resolve(target)), target);
});
test('documented public quota defaults match the deploy configuration', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.vars.ACCESS_MODE, 'public');
  assert.equal(config.vars.PUBLIC_DAILY_MODEL_CALLS, '60');
  assert.equal(config.vars.PUBLIC_DAILY_SEARCH_CALLS, '300');
  const banner = fs.readFileSync('docs/assets/readme-banner.svg', 'utf8');
  assert.ok(banner.includes('PatentFlow AI')); assert.doesNotMatch(banner, /<script|onload=/i);
});

test('traffic storage is isolated from public quotas and its additive migration is retained', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.ok(config.durable_objects.bindings.some(binding => binding.name === 'SITE_TRAFFIC' && binding.class_name === 'SiteTraffic'));
  assert.ok(config.durable_objects.bindings.some(binding => binding.name === 'PUBLIC_QUOTA' && binding.class_name === 'PublicQuota'));
  assert.deepEqual(config.migrations.map(migration => migration.tag), ['public-quota-v1', 'site-traffic-v1']);
  assert.deepEqual(config.migrations[1].new_sqlite_classes, ['SiteTraffic']);
});
test('every wrangler.jsonc var is documented with its default in the deploy guide', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const guide = fs.readFileSync('docs/cloudflare-deploy.md', 'utf8');
  const rows = new Map([...guide.matchAll(/^\|\s*([A-Z][A-Z0-9_]+)\s*\|\s*([^|]+?)\s*\|/gm)].map(([, name, value]) => [name, value]));
  for (const [name, value] of Object.entries(config.vars)) assert.equal(rows.get(name), value, name);
});
