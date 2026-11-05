import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { assertPortFree, waitForPortsFree } from './worker-ports.mjs';

async function listen(t) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, port: server.address().port };
}

test('initial port checks reject occupied ports without touching the listener', async t => {
  const { server, port } = await listen(t);
  await assert.rejects(assertPortFree(port), { code: 'EADDRINUSE' });
  assert.equal(server.listening, true);
});

test('shutdown wait observes a delayed socket release', async t => {
  const { server, port } = await listen(t);
  const timer = setTimeout(() => server.close(), 30);
  t.after(() => clearTimeout(timer));
  await waitForPortsFree([port], { timeoutMs: 2000, intervalMs: 10 });
  assert.equal(server.listening, false);
  await assertPortFree(port);
});

test('shutdown wait stays bounded and never evicts an occupied listener', async t => {
  const { server, port } = await listen(t);
  await assert.rejects(waitForPortsFree([port], { timeoutMs: 50, intervalMs: 10 }), { code: 'EADDRINUSE' });
  assert.equal(server.listening, true);
});

test('shutdown wait can be cancelled without touching the listener', async t => {
  const { server, port } = await listen(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  t.after(() => clearTimeout(timer));
  await assert.rejects(waitForPortsFree([port], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(server.listening, true);
});

test('shutdown wait does not retry non-occupancy errors', async () => {
  await assert.rejects(waitForPortsFree([-1]), { code: 'ERR_SOCKET_BAD_PORT' });
});
