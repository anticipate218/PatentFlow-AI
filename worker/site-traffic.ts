import { quotaDay } from './public-quota.ts';
import type { TrafficSnapshot } from '../src/site-traffic-types.ts';

export interface TrafficStorage {
  sql: { exec<T extends Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] } };
  transactionSync<T>(operation: () => T): T;
}
export interface TrafficEnv {
  SITE_TRAFFIC?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}
export const TRAFFIC_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Aggregate counts and hashes of anonymous gate sessions only; never IPs, URLs or content. */
export class SiteTraffic {
  private storage: TrafficStorage;
  constructor(state: { storage: TrafficStorage }) {
    this.storage = state.storage;
    const sql = this.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS traffic_total (id INTEGER PRIMARY KEY, views INTEGER NOT NULL, visitors INTEGER NOT NULL, started_at TEXT)');
    sql.exec('INSERT OR IGNORE INTO traffic_total VALUES (1, 0, 0, NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS traffic_days (day TEXT PRIMARY KEY, views INTEGER NOT NULL, visitors INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS traffic_visitors (digest TEXT PRIMARY KEY, last_day TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS traffic_events (visitor TEXT NOT NULL, event TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY(visitor, event))');
    sql.exec('CREATE INDEX IF NOT EXISTS traffic_event_time ON traffic_events(at_ms)');
  }

  private snapshot(now: number): TrafficSnapshot {
    const total = this.storage.sql.exec<{ views: number; visitors: number; started_at: string | null }>('SELECT views, visitors, started_at FROM traffic_total WHERE id = 1').toArray()[0];
    const { day } = quotaDay(now);
    const today = this.storage.sql.exec<{ views: number; visitors: number }>('SELECT views, visitors FROM traffic_days WHERE day = ?', day).toArray()[0];
    return { ok: true, timezone: 'Asia/Shanghai', startedAt: total.started_at,
      total: { views: total.views, visitors: total.visitors },
      today: { day, views: today?.views ?? 0, visitors: today?.visitors ?? 0 } };
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/summary') return Response.json(this.snapshot(Date.now()));
    if (request.method !== 'POST' || path !== '/record') return new Response('Not found', { status: 404 });
    const body = await request.json().catch(() => null) as { visitor?: unknown; eventId?: unknown } | null;
    if (typeof body?.visitor !== 'string' || !/^[a-f0-9]{64}$/.test(body.visitor)
      || typeof body.eventId !== 'string' || !TRAFFIC_EVENT_ID.test(body.eventId)) return new Response('Invalid event', { status: 400 });
    const visitor = body.visitor, eventId = body.eventId.toLowerCase(), now = Date.now(), { day } = quotaDay(now);
    const result = this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      // Retries of one page must not inflate counts, even across the daily boundary.
      const duplicate = sql.exec('SELECT event FROM traffic_events WHERE visitor = ? AND event = ?', visitor, eventId).toArray().length > 0;
      if (duplicate) return this.snapshot(now);
      const previous = sql.exec<{ last_day: string }>('SELECT last_day FROM traffic_visitors WHERE digest = ?', visitor).toArray()[0];
      sql.exec('INSERT INTO traffic_events VALUES (?, ?, ?)', visitor, eventId, now);
      sql.exec('INSERT INTO traffic_visitors VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET last_day = excluded.last_day', visitor, day);
      sql.exec('UPDATE traffic_total SET views = views + 1, visitors = visitors + ?, started_at = COALESCE(started_at, ?) WHERE id = 1', previous ? 0 : 1, new Date(now).toISOString());
      sql.exec('INSERT INTO traffic_days VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors', day, previous?.last_day === day ? 0 : 1);
      sql.exec('DELETE FROM traffic_events WHERE at_ms < ?', now - 48 * 3600_000);
      sql.exec('DELETE FROM traffic_days WHERE day < ?', quotaDay(now - 90 * 86400_000).day);
      return this.snapshot(now);
    });
    return Response.json(result);
  }
}

export async function trafficVisitorDigest(secret: string, sessionTag: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('site-traffic-v1:' + sessionTag)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function trafficOptOut(request: Request): boolean {
  return request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1'
    || /bot\b|crawler|spider|slurp|bingpreview/i.test(request.headers.get('User-Agent') ?? '');
}
