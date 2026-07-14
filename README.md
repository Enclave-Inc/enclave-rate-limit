# @enclave/rate-limit

Shared rate limiting for Enclave product APIs (Supabase edge functions). Infra
only — no dependency on `@enclave/pqc-primitives` or product SDKs.

Design mirrors `enclave-pqc-primitives`' provider seam: call sites depend on
`RateLimitProvider`; today the concrete backend is `PostgresProvider`. A
Redis/Upstash provider can be added later without changing handlers.

## Modes (read this before choosing)

| Mode | Behavior | When to use |
|------|----------|-------------|
| **`throttle`** | Always returns `allowed: true`, but sets growing `retryAfterSeconds` (`min(maxDelay, base × 2^attemptCount)`). **Caller** must enforce the delay (sleep / `Retry-After` / delayed job). Never hard-denies on count alone. | **Default for auth/login.** Hard lockout on login is itself an attack: an adversary can lock a victim out by repeatedly failing their login — no password required. |
| **`lockout`** | Once `attemptCount` **exceeds** `maxAttempts` inside the window, further calls return `allowed: false` until `locked_until` passes. | Elevated / admin paths where locking a bad actor matters more than guaranteeing availability for the legitimate owner. |

This package supports both; it does **not** pick for you.

## Install into a consuming `enclave-*-api` repo

1. **Copy the migration** (this package cannot apply SQL to your project):

   ```bash
   cp node_modules/@enclave/rate-limit/supabase/migrations/20260714010000_rate_limit_counters.sql \
     supabase/migrations/$(date -u +%Y%m%d%H%M%S)_rate_limit_counters.sql
   # or, with a file: dependency: copy from the sibling Enclave-Inc checkout
   ```

   Then `supabase db push` (or your normal migration path).

2. **Add the dependency** (file / npm as preferred by your monorepo):

   ```json
   "@enclave/rate-limit": "file:../../Enclave-Inc/enclave-rate-limit"
   ```

3. **Instantiate with your service-role client**:

   ```ts
   import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
   import { PostgresProvider } from "@enclave/rate-limit";

   const admin = createClient(url, serviceRoleKey, {
     auth: { autoRefreshToken: false, persistSession: false },
   });
   const rateLimit = new PostgresProvider(admin);
   ```

## Throttle example (auth login failures)

```ts
const key = `auth:login:email:${email.toLowerCase()}`;
const result = await rateLimit.checkAndIncrement(key, {
  windowSeconds: 15 * 60,
  maxAttempts: 10, // soft intent; delay still grows every attempt
  mode: "throttle",
  baseDelaySeconds: 1,
  maxDelaySeconds: 60,
});

if (result.retryAfterSeconds && result.retryAfterSeconds > 0) {
  // Enforce delay yourself — e.g. HTTP 429 with Retry-After, or sleep in a worker.
  return new Response(JSON.stringify({ error: "Too many attempts" }), {
    status: 429,
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  });
}

// … continue login verify …

// After success, clear the window so prior failures don't keep inflating delay:
await rateLimit.reset(key);
```

## Lockout example (admin elevated action)

```ts
const key = `admin:elevate:user:${userId}`;
const result = await rateLimit.checkAndIncrement(key, {
  windowSeconds: 30 * 60,
  maxAttempts: 5,
  mode: "lockout",
  lockoutSeconds: 30 * 60,
});

if (!result.allowed) {
  return new Response(JSON.stringify({ error: "Locked out" }), {
    status: 429,
    headers: {
      "Retry-After": String(result.retryAfterSeconds ?? 60),
    },
  });
}
```

## Scheduled cleanup

The package exposes `cleanupExpired(maxAgeSeconds?)` but **does not** schedule it.
In the consuming repo, add a scheduled edge function or `pg_cron` job:

```ts
// supabase/functions/rate-limit-cleanup/index.ts
const rateLimit = new PostgresProvider(admin);
const deleted = await rateLimit.cleanupExpired(86_400); // 24h
return new Response(JSON.stringify({ deleted }));
```

Wire with Supabase Scheduled Functions / an external cron hitting that endpoint
with a service secret.

## Atomicity

Increments go through `rate_limit_check_and_increment` (migration RPC) using
`SELECT … FOR UPDATE` / insert-retry — not a client-side read-then-write — so
concurrent edge invocations on the same key do not drop counts.

## Development

```bash
npm install
npm run build
npm test
```
