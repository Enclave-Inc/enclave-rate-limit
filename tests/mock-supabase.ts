/**
 * In-memory Supabase-shaped client that mirrors the SQL RPCs' semantics so CI
 * can exercise PostgresProvider without a live database.
 */

export type CounterRow = {
  key: string;
  windowStart: number;
  attemptCount: number;
  lockedUntil: number | null;
};

type RpcArgs = Record<string, unknown>;

export class MockRateLimitStore {
  readonly rows = new Map<string, CounterRow>();
  /** Serialize per-key mutations to approximate FOR UPDATE. */
  readonly #locks = new Map<string, Promise<void>>();

  async withLock(key: string, fn: () => void | Promise<void>): Promise<void> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const next = prev.then(async () => {
      try {
        await fn();
      } finally {
        release();
      }
    });
    this.#locks.set(key, next.catch(() => undefined));
    await next;
  }

  createClient() {
    const store = this;
    return {
      rpc(name: string, args: RpcArgs) {
        return store.#rpc(name, args);
      },
    };
  }

  async #rpc(
    name: string,
    args: RpcArgs,
  ): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      if (name === "rate_limit_check_and_increment") {
        const data = await this.#checkAndIncrement(args);
        return { data, error: null };
      }
      if (name === "rate_limit_reset") {
        const key = String(args.p_key ?? "");
        this.rows.delete(key);
        return { data: null, error: null };
      }
      if (name === "rate_limit_cleanup_expired") {
        const maxAge = Number(args.p_max_age_seconds ?? 86_400);
        const now = Date.now();
        let deleted = 0;
        for (const [k, row] of this.rows) {
          const ageMs = now - row.windowStart;
          const unlocked =
            row.lockedUntil === null || row.lockedUntil < now;
          if (ageMs > maxAge * 1000 && unlocked) {
            this.rows.delete(k);
            deleted += 1;
          }
        }
        return { data: deleted, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    } catch (err) {
      return {
        data: null,
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async #checkAndIncrement(args: RpcArgs): Promise<Record<string, unknown>> {
    const key = String(args.p_key ?? "").trim();
    const windowSeconds = Number(args.p_window_seconds);
    const maxAttempts = Number(args.p_max_attempts);
    const mode = String(args.p_mode);
    const baseDelay = Number(args.p_base_delay_seconds ?? 1);
    const maxDelay = Number(args.p_max_delay_seconds ?? 300);
    const lockoutSeconds = Number(
      args.p_lockout_seconds ?? windowSeconds,
    );

    if (!key) throw new Error("rate_limit key must not be empty");
    if (!(windowSeconds > 0)) throw new Error("window_seconds must be > 0");
    if (maxAttempts < 0) throw new Error("max_attempts must be >= 0");
    if (mode !== "throttle" && mode !== "lockout") {
      throw new Error("mode must be throttle or lockout");
    }

    let result: Record<string, unknown> = {};

    await this.withLock(key, () => {
      const now = Date.now();
      const existing = this.rows.get(key);

      if (existing?.lockedUntil != null && existing.lockedUntil > now) {
        result = {
          allowed: false,
          attemptCount: existing.attemptCount,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((existing.lockedUntil - now) / 1000),
          ),
        };
        return;
      }

      let windowStart: number;
      let attempt: number;
      if (existing?.lockedUntil != null && existing.lockedUntil <= now) {
        // Expired lockout → fresh window (matches SQL migration).
        windowStart = now;
        attempt = 1;
      } else if (
        existing &&
        existing.windowStart > now - windowSeconds * 1000
      ) {
        windowStart = existing.windowStart;
        attempt = existing.attemptCount + 1;
      } else {
        windowStart = now;
        attempt = 1;
      }

      let lockedUntil: number | null = null;
      if (mode === "lockout" && attempt > maxAttempts) {
        lockedUntil = now + lockoutSeconds * 1000;
      }

      this.rows.set(key, {
        key,
        windowStart,
        attemptCount: attempt,
        lockedUntil,
      });

      if (mode === "lockout" && attempt > maxAttempts) {
        result = {
          allowed: false,
          attemptCount: attempt,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(((lockedUntil ?? now) - now) / 1000),
          ),
        };
        return;
      }

      if (mode === "throttle") {
        const retryAfterSeconds = Math.min(
          maxDelay,
          baseDelay * 2 ** Math.min(attempt, 30),
        );
        result = {
          allowed: true,
          attemptCount: attempt,
          retryAfterSeconds,
        };
        return;
      }

      result = { allowed: true, attemptCount: attempt };
    });

    return result;
  }
}
