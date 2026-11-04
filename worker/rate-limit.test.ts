import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "./rate-limit.ts";

test("sliding windows expire hits at the exact boundary and rejected requests do not extend it", () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 0), true);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 100), true);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 999), false);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 1000), true);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 1099), false);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 1100), true);
});

test("keys are independent, zero disables the check, and separate isolates do not share quotas", () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.allow("synthetic-a", 1, 1000, 0), true);
  assert.equal(limiter.allow("synthetic-a", 1, 1000, 0), false);
  assert.equal(limiter.allow("synthetic-b", 1, 1000, 0), true);
  assert.equal(limiter.allow("synthetic-a", 0, 1000, 0), true);
  assert.equal(new RateLimiter().allow("synthetic-a", 1, 1000, 0), true);
});

test("a large map drops keys whose own window has passed, at most once per minute, and keeps active limits", () => {
  const limiter = new RateLimiter();
  for (let index = 0; index <= 5000; index += 1) assert.equal(limiter.allow(`synthetic-short-${index}`, 1, 1000, 0), true);
  // The first sweep ran at t=0 and kept every key; the next one may not run before t=60000.
  assert.equal(limiter.size, 5001);
  assert.equal(limiter.allow("synthetic-long", 1, 3_600_000, 0), true);
  assert.equal(limiter.allow("synthetic-mid", 1, 1000, 30_000), true);
  assert.equal(limiter.size, 5003);
  assert.equal(limiter.allow("synthetic-fresh", 1, 1000, 60_000), true);
  // Short windows expired long ago; the hour-long key is still inside its window and keeps blocking.
  assert.equal(limiter.size, 2);
  assert.equal(limiter.allow("synthetic-long", 1, 3_600_000, 60_000), false);
});
