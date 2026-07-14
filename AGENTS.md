# AGENTS.md — enclave-rate-limit

Shared rate limiting for Enclave `*-api` Supabase edge functions.

## Rules

1. Infra only — no `@enclave/pqc-primitives`, no product SDKs.
2. Depend on {@link RateLimitProvider}; ship {@link PostgresProvider} now.
3. Atomic increments via migration RPCs — never client read-then-write.
4. This package does not own Supabase projects. Consumers **copy** the SQL
   migration into their own `supabase/migrations/`.
5. Prefer **throttle** for auth/login paths; reserve **lockout** for
   elevated-privilege / admin-style endpoints (see README).

## Commands

```bash
npm install
npm run build
npm test
```
