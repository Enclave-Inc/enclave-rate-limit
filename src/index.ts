/**
 * `@enclave/rate-limit` — shared rate limiting for Enclave product APIs.
 *
 * Infra only: no dependency on `@enclave/pqc-primitives` or product SDKs.
 * Swap {@link PostgresProvider} for a Redis/Upstash provider later by
 * implementing {@link RateLimitProvider}.
 */

export type {
  RateLimitMode,
  RateLimitOptions,
  RateLimitProvider,
  RateLimitResult,
} from "./types.js";
export { DEFAULT_TABLE_NAME } from "./types.js";

export {
  PostgresProvider,
  type PostgresProviderOptions,
} from "./postgres-provider.js";
