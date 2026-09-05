/**
 * Wing: auth | Topic: oauth-abuse-control | Updated: 2026-08-26
 */

import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../../src/auth/fixed-window-rate-limiter.js";

describe("FixedWindowRateLimiter", () => {
  it("denies excess attempts and resets after the window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowSeconds: 60,
      now: () => now
    });

    expect(limiter.consume("peer")).toEqual({
      allowed: true,
      retryAfterSeconds: 0
    });
    expect(limiter.consume("peer")).toEqual({
      allowed: true,
      retryAfterSeconds: 0
    });
    expect(limiter.consume("peer")).toEqual({
      allowed: false,
      retryAfterSeconds: 60
    });

    now += 60;
    expect(limiter.consume("peer")).toEqual({
      allowed: true,
      retryAfterSeconds: 0
    });
  });

  it("keeps independent counters per trusted peer key", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowSeconds: 60
    });

    expect(limiter.consume("peer-a").allowed).toBe(true);
    expect(limiter.consume("peer-a").allowed).toBe(false);
    expect(limiter.consume("peer-b").allowed).toBe(true);
  });
});
