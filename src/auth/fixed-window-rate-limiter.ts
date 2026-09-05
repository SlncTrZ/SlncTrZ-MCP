/**
 * Fixed Window Rate Limiter — bounds OAuth abuse per direct peer address.
 * Wing: auth | Topic: oauth-abuse-control | Updated: 2026-08-26
 *
 * Provenance: SECURITY invariants 1 and 12; standalone in-process design.
 */

interface Counter {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly now?: () => number;
}

/** Small in-memory limiter. Callers deliberately choose the trusted peer key. */
export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowSeconds: number;
  readonly #now: () => number;
  readonly #counters = new Map<string, Counter>();

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new RangeError("Rate limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.windowSeconds) || options.windowSeconds <= 0) {
      throw new RangeError("Rate-limit window must be a positive safe integer");
    }

    this.#limit = options.limit;
    this.#windowSeconds = options.windowSeconds;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  consume(key: string): RateLimitDecision {
    const now = this.#now();
    const current = this.#counters.get(key);

    if (current === undefined || current.resetAt <= now) {
      this.#counters.set(key, {
        count: 1,
        resetAt: now + this.#windowSeconds
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= this.#limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, current.resetAt - now)
      };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
