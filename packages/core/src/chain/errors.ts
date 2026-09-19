/**
 * `AdapterShapeError` for chain/'s own external boundary — the gateway's `GET /key` JSON
 * response (S-03, CLAUDE.md #6: "Unknown shape -> typed AdapterShapeError, redacted sample
 * appended"). RPC results decoded by viem (contract reads, `getBalance`) are validated by their
 * ABI at decode time — a shape mismatch there throws viem's own typed
 * `ContractFunctionExecutionError`/`AbiDecodingZeroDataError` etc., which is the validation
 * mechanism for that half of the ticket's AC6; this module only covers the JSON half.
 *
 * Deliberately a separate, chain-local class rather than a reuse of `mcp/schemas.ts`'s (frozen
 * per CLAUDE.md banner: "do not build on it") or `router/errors.ts`'s (typed to that module's
 * own two sources) — same reasoning `router/errors.ts` gives for not reusing `mcp/schemas.ts`.
 */

export type ChainAdapterShapeSource = 'gateway_key';

/** Thrown when `GET /key` returns 2xx but a body missing `balance.available`/`balance.used`
 *  (or not JSON at all). Never swallowed — the caller (readApiBalance) lets this propagate. */
export class AdapterShapeError extends Error {
  readonly source: ChainAdapterShapeSource;
  /** Deep-redacted copy of the offending value — safe to log. Never the raw value. */
  readonly redactedSample: unknown;

  constructor(source: ChainAdapterShapeSource, issues: string, redactedSample: unknown) {
    super(`AdapterShapeError: ${source} returned an unrecognized shape: ${issues}`);
    this.name = 'AdapterShapeError';
    this.source = source;
    this.redactedSample = redactedSample;
  }
}

/** Thrown when `GET /key` itself fails (non-2xx HTTP status) — distinct from a shape problem: the
 *  body may be a well-formed Orbio error object (e.g. "unknown or revoked key"), just not a
 *  balance. Carries a redacted body sample so a caller can log it safely. */
export class GatewayKeyHttpError extends Error {
  readonly status: number;
  readonly redactedBody: unknown;

  constructor(status: number, redactedBody: unknown) {
    super(`GET /key failed with HTTP ${status}`);
    this.name = 'GatewayKeyHttpError';
    this.status = status;
    this.redactedBody = redactedBody;
  }
}
