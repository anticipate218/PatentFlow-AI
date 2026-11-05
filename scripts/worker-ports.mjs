import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', cause => {
      const error = new Error(`Port ${port} is occupied or unavailable; its owner was not touched.`, { cause });
      error.code = cause.code;
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

// Use only after stopping an owned process. Initial port checks must fail immediately.
// A parent's close event can arrive before its workerd descendants release their sockets.
export async function waitForPortsFree(ports, { timeoutMs = 5000, intervalMs = 50, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    try {
      await Promise.all(ports.map(assertPortFree));
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
      await delay(Math.min(intervalMs, deadline - Date.now()), undefined, { signal });
    }
  }
}
