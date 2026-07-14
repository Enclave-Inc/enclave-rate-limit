import { describe, expect, it } from "vitest";
import { PostgresProvider } from "../src/index.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MockRateLimitStore } from "./mock-supabase.js";

function providerFrom(store: MockRateLimitStore): PostgresProvider {
  return new PostgresProvider(store.createClient() as unknown as SupabaseClient);
}

describe("PostgresProvider throttle mode", () => {
  it("always allows and increases retryAfterSeconds exponentially", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    const key = "auth:login:email:user@example.com";
    const opts = {
      windowSeconds: 60,
      maxAttempts: 5,
      mode: "throttle" as const,
      baseDelaySeconds: 1,
      maxDelaySeconds: 300,
    };

    const r1 = await rl.checkAndIncrement(key, opts);
    expect(r1.allowed).toBe(true);
    expect(r1.attemptCount).toBe(1);
    expect(r1.retryAfterSeconds).toBe(2); // 1 * 2^1

    const r2 = await rl.checkAndIncrement(key, opts);
    expect(r2.allowed).toBe(true);
    expect(r2.attemptCount).toBe(2);
    expect(r2.retryAfterSeconds).toBe(4); // 1 * 2^2

    const r3 = await rl.checkAndIncrement(key, opts);
    expect(r3.allowed).toBe(true);
    expect(r3.attemptCount).toBe(3);
    expect(r3.retryAfterSeconds).toBe(8);
  });

  it("caps delay at maxDelaySeconds", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    const opts = {
      windowSeconds: 600,
      maxAttempts: 100,
      mode: "throttle" as const,
      baseDelaySeconds: 10,
      maxDelaySeconds: 30,
    };
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await rl.checkAndIncrement("k", opts);
      expect(r.allowed).toBe(true);
      last = r.retryAfterSeconds ?? 0;
    }
    expect(last).toBe(30);
  });
});

describe("PostgresProvider lockout mode", () => {
  it("denies after attemptCount exceeds maxAttempts", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    const key = "admin:elevate:user:42";
    const opts = {
      windowSeconds: 300,
      maxAttempts: 3,
      mode: "lockout" as const,
      lockoutSeconds: 120,
    };

    for (let i = 0; i < 3; i += 1) {
      const r = await rl.checkAndIncrement(key, opts);
      expect(r.allowed).toBe(true);
      expect(r.attemptCount).toBe(i + 1);
    }

    const locked = await rl.checkAndIncrement(key, opts);
    expect(locked.allowed).toBe(false);
    expect(locked.attemptCount).toBe(4);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    const still = await rl.checkAndIncrement(key, opts);
    expect(still.allowed).toBe(false);
  });

  it("un-denies after locked_until passes", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    const key = "lockout:temp";
    const opts = {
      windowSeconds: 60,
      maxAttempts: 1,
      mode: "lockout" as const,
      lockoutSeconds: 1,
    };

    expect((await rl.checkAndIncrement(key, opts)).allowed).toBe(true);
    const denied = await rl.checkAndIncrement(key, opts);
    expect(denied.allowed).toBe(false);

    const row = store.rows.get(key)!;
    row.lockedUntil = Date.now() - 1000;

    const after = await rl.checkAndIncrement(key, opts);
    expect(after.allowed).toBe(true);
    expect(after.attemptCount).toBe(1);
  });
});

describe("PostgresProvider reset + cleanup", () => {
  it("reset() clears state so the next attempt starts fresh", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    const key = "auth:login:email:reset@example.com";
    const opts = {
      windowSeconds: 60,
      maxAttempts: 5,
      mode: "throttle" as const,
      baseDelaySeconds: 1,
      maxDelaySeconds: 300,
    };

    await rl.checkAndIncrement(key, opts);
    await rl.checkAndIncrement(key, opts);
    expect(store.rows.get(key)?.attemptCount).toBe(2);

    await rl.reset(key);
    expect(store.rows.has(key)).toBe(false);

    const again = await rl.checkAndIncrement(key, opts);
    expect(again.attemptCount).toBe(1);
    expect(again.retryAfterSeconds).toBe(2);
  });

  it("cleanupExpired removes aged unlocked rows", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    store.rows.set("old", {
      key: "old",
      windowStart: Date.now() - 10_000,
      attemptCount: 3,
      lockedUntil: null,
    });
    store.rows.set("fresh", {
      key: "fresh",
      windowStart: Date.now(),
      attemptCount: 1,
      lockedUntil: null,
    });

    const deleted = await rl.cleanupExpired(5);
    expect(deleted).toBe(1);
    expect(store.rows.has("old")).toBe(false);
    expect(store.rows.has("fresh")).toBe(true);
  });
});

describe("concurrent increments", () => {
  it("does not lose updates under parallel checkAndIncrement", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    const key = "concurrent:key";
    const opts = {
      windowSeconds: 120,
      maxAttempts: 1000,
      mode: "throttle" as const,
      baseDelaySeconds: 1,
      maxDelaySeconds: 10_000,
    };

    const n = 40;
    await Promise.all(
      Array.from({ length: n }, () => rl.checkAndIncrement(key, opts)),
    );

    expect(store.rows.get(key)?.attemptCount).toBe(n);
  });
});

describe("input validation", () => {
  it("rejects empty keys and invalid options", async () => {
    const store = new MockRateLimitStore();
    const rl = providerFrom(store);
    await expect(
      rl.checkAndIncrement("  ", {
        windowSeconds: 60,
        maxAttempts: 5,
        mode: "throttle",
      }),
    ).rejects.toThrow(/empty/);

    await expect(
      rl.checkAndIncrement("k", {
        windowSeconds: 0,
        maxAttempts: 5,
        mode: "lockout",
      }),
    ).rejects.toThrow(/windowSeconds/);
  });
});
