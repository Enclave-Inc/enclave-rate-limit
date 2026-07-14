/**
 * Postgres / Supabase implementation of {@link RateLimitProvider}.
 *
 * Uses SECURITY DEFINER RPCs from the package migration for atomic increments.
 * Pass in the caller's service-role Supabase client — this package does not own
 * connection configuration.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_TABLE_NAME,
  type RateLimitOptions,
  type RateLimitProvider,
  type RateLimitResult,
} from "./types.js";

export type PostgresProviderOptions = {
  /**
   * Must match the migrated table (`rate_limit_counters`). Custom names are
   * not supported by the shipped RPCs — fork/adapt the migration if needed.
   * @default "rate_limit_counters"
   */
  tableName?: string;
};

type RpcResult = {
  allowed: boolean;
  attemptCount: number;
  retryAfterSeconds?: number | null;
};

/**
 * Concrete {@link RateLimitProvider} backed by Postgres via Supabase RPCs.
 *
 * A Redis/Upstash provider can implement the same interface later without
 * changing product-API call sites.
 */
export class PostgresProvider implements RateLimitProvider {
  readonly #client: SupabaseClient;
  readonly #tableName: string;

  constructor(client: SupabaseClient, options: PostgresProviderOptions = {}) {
    if (!client) {
      throw new Error("PostgresProvider requires a Supabase client");
    }
    this.#client = client;
    this.#tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    if (this.#tableName !== DEFAULT_TABLE_NAME) {
      throw new Error(
        `PostgresProvider only supports table "${DEFAULT_TABLE_NAME}" ` +
          `(shipped RPC migration). Got "${this.#tableName}".`,
      );
    }
  }

  async checkAndIncrement(
    key: string,
    opts: RateLimitOptions,
  ): Promise<RateLimitResult> {
    const normalized = normalizeKey(key);
    validateOptions(opts);

    const { data, error } = await this.#client.rpc(
      "rate_limit_check_and_increment",
      {
        p_key: normalized,
        p_window_seconds: opts.windowSeconds,
        p_max_attempts: opts.maxAttempts,
        p_mode: opts.mode,
        p_base_delay_seconds: opts.baseDelaySeconds ?? 1,
        p_max_delay_seconds: opts.maxDelaySeconds ?? 300,
        p_lockout_seconds: opts.lockoutSeconds ?? null,
      },
    );

    if (error) {
      throw new Error(`rate_limit_check_and_increment failed: ${error.message}`);
    }

    return parseRpcResult(data);
  }

  async reset(key: string): Promise<void> {
    const normalized = normalizeKey(key);
    const { error } = await this.#client.rpc("rate_limit_reset", {
      p_key: normalized,
    });
    if (error) {
      throw new Error(`rate_limit_reset failed: ${error.message}`);
    }
  }

  async cleanupExpired(maxAgeSeconds = 86_400): Promise<number> {
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
      throw new Error("maxAgeSeconds must be a positive integer");
    }
    const { data, error } = await this.#client.rpc("rate_limit_cleanup_expired", {
      p_max_age_seconds: maxAgeSeconds,
    });
    if (error) {
      throw new Error(`rate_limit_cleanup_expired failed: ${error.message}`);
    }
    const n = typeof data === "number" ? data : Number(data);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("rate_limit_cleanup_expired returned a non-number");
    }
    return Math.trunc(n);
  }
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("rate-limit key must not be empty");
  }
  return trimmed;
}

function validateOptions(opts: RateLimitOptions): void {
  if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds <= 0) {
    throw new Error("windowSeconds must be a positive integer");
  }
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 0) {
    throw new Error("maxAttempts must be a non-negative integer");
  }
  if (opts.mode !== "throttle" && opts.mode !== "lockout") {
    throw new Error('mode must be "throttle" or "lockout"');
  }
}

function parseRpcResult(data: unknown): RateLimitResult {
  if (!data || typeof data !== "object") {
    throw new Error("rate_limit_check_and_increment returned unexpected payload");
  }
  const raw = data as RpcResult;
  if (typeof raw.allowed !== "boolean" || typeof raw.attemptCount !== "number") {
    throw new Error("rate_limit_check_and_increment returned malformed fields");
  }
  const result: RateLimitResult = {
    allowed: raw.allowed,
    attemptCount: raw.attemptCount,
  };
  if (
    raw.retryAfterSeconds !== undefined &&
    raw.retryAfterSeconds !== null &&
    typeof raw.retryAfterSeconds === "number"
  ) {
    result.retryAfterSeconds = raw.retryAfterSeconds;
  }
  return result;
}
