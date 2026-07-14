/**
 * Rate-limit provider contract.
 *
 * Mirror of the CryptoProvider seam in enclave-pqc-primitives: product APIs
 * depend on {@link RateLimitProvider}, and a Redis/Upstash implementation can
 * replace {@link PostgresProvider} later without changing call sites.
 */

/** Throttle vs lockout — see package README for the security trade-off. */
export type RateLimitMode = "throttle" | "lockout";

export interface RateLimitOptions {
  /** Sliding / fixed window length in seconds. */
  windowSeconds: number;
  /**
   * Lockout: deny after `attemptCount` exceeds this value within the window.
   * Throttle: used as documentation of intended soft limit; delay still grows
   * with every attempt in the window.
   */
  maxAttempts: number;
  mode: RateLimitMode;
  /**
   * Throttle only: base for `retryAfterSeconds = min(maxDelay, base * 2^n)`.
   * @default 1
   */
  baseDelaySeconds?: number;
  /**
   * Throttle only: upper bound on suggested delay.
   * @default 300
   */
  maxDelaySeconds?: number;
  /**
   * Lockout only: how long to keep `locked_until` after the threshold.
   * @default windowSeconds
   */
  lockoutSeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  attemptCount: number;
  /** Present when the caller should wait (denied lockout, or throttle delay). */
  retryAfterSeconds?: number;
}

/**
 * Swappable rate-limit backend.
 *
 * Call sites must not branch on provider type — only on {@link RateLimitResult}.
 */
export interface RateLimitProvider {
  /**
   * Atomically record an attempt for `key` and return whether the caller may
   * proceed (plus any suggested wait).
   */
  checkAndIncrement(
    key: string,
    opts: RateLimitOptions,
  ): Promise<RateLimitResult>;

  /**
   * Clear counter state for `key` (e.g. after a successful login so prior
   * failures do not keep raising throttle delay).
   */
  reset(key: string): Promise<void>;

  /**
   * Delete stale rows past `maxAgeSeconds` (default 86400). Wire this from a
   * scheduled edge function / pg_cron in the consuming repo — this package
   * does not schedule jobs.
   *
   * @returns number of deleted rows
   */
  cleanupExpired(maxAgeSeconds?: number): Promise<number>;
}

/** Default table + RPC names from the published migration. */
export const DEFAULT_TABLE_NAME = "rate_limit_counters" as const;
