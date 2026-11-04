/**
 * Sliding-window limiter kept in isolate memory. Best effort: Cloudflare may run several isolates,
 * and may evict/restart them at any time. Limits do not aggregate across isolates or survive restarts.
 * A hard shared quota needs coordinated storage such as Durable Objects; this only slows local bursts.
 * A nonpositive limit deliberately disables this local check.
 */
const MAX_KEYS = 5000;
const PRUNE_EVERY_MS = 60_000;

interface Bucket {
  hits: number[];
  windowMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private prunedAt = Number.NEGATIVE_INFINITY;

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (limit <= 0) return true;
    const since = now - windowMs;
    const hits = (this.buckets.get(key)?.hits || []).filter((time) => time > since);
    const allowed = hits.length < limit;
    if (allowed) hits.push(now);
    this.buckets.set(key, { hits, windowMs });
    // Pruning walks every key, so a large map is swept at most once per interval, not on every request.
    if (this.buckets.size > MAX_KEYS && now - this.prunedAt >= PRUNE_EVERY_MS) this.prune(now);
    return allowed;
  }

  /** Number of keys currently held in memory. */
  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number) {
    this.prunedAt = now;
    // A key whose newest hit has left its own window no longer affects any decision.
    for (const [key, bucket] of this.buckets) {
      const last = bucket.hits[bucket.hits.length - 1];
      if (last === undefined || last <= now - bucket.windowMs) this.buckets.delete(key);
    }
  }
}
