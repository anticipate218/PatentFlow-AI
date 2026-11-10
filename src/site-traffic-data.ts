import type { TrafficSnapshot } from './site-traffic-types.ts';
export type { TrafficSnapshot } from './site-traffic-types.ts';

export function trafficDayLabel(snapshot: TrafficSnapshot | undefined, now = Date.now()): string {
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  return !snapshot || snapshot.today.day === today ? '今日' : snapshot.today.day + '（历史快照）';
}

export function nextTrafficDayDelay(now = Date.now()): number {
  const day = 86400_000, offset = 8 * 3600_000;
  return day - ((now + offset) % day) + 50;
}

/** A delayed initial POST must not overwrite a newer read after midnight. */
export function newestTrafficSnapshot(current: TrafficSnapshot | undefined, incoming: TrafficSnapshot): TrafficSnapshot {
  if (!current) return incoming;
  if (incoming.today.day < current.today.day) return current;
  if (incoming.today.day === current.today.day && incoming.total.views < current.total.views) return current;
  return incoming;
}

export function parseTrafficSnapshot(value: unknown): TrafficSnapshot {
  const data = value as TrafficSnapshot | null;
  const count = (number: unknown) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (!data || data.ok !== true || data.timezone !== 'Asia/Shanghai'
    || !(data.startedAt === null || (typeof data.startedAt === 'string' && Number.isFinite(Date.parse(data.startedAt))))
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.today?.day ?? '')
    || ![data.total?.views, data.total?.visitors, data.today?.views, data.today?.visitors].every(count)) {
    throw new Error('访问统计暂不可用');
  }
  return data;
}

/** One page ID and one in-flight write, including React StrictMode remounts and retries. */
export function createTrafficClient(fetchImpl: typeof fetch, eventId: string, optOut = false) {
  let recorded: Promise<TrafficSnapshot> | undefined;
  async function request(method: 'GET' | 'POST') {
    const response = await fetchImpl('/api/traffic', {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000),
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId }) } : {}),
    });
    if (!response.ok) throw new Error('访问统计暂不可用');
    return parseTrafficSnapshot(await response.json());
  }
  return {
    record() {
      if (!recorded) recorded = request(optOut ? 'GET' : 'POST').catch(error => { recorded = undefined; throw error; });
      return recorded;
    },
    refresh: () => request('GET'),
    optOut,
  };
}
