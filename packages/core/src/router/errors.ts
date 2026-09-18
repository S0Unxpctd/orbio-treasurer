/**
 * `AdapterShapeError` for the router's own upstream boundary (S-01, CLAUDE.md #6: "Unknown shape
 * → typed AdapterShapeError, redacted sample appended"). Deliberately a separate, router-local
 * class rather than a reuse of `mcp/schemas.ts`'s — the MCP client is frozen/obsolete for Sprint
 * 1.0 (CLAUDE.md banner: "do not build on it") and the router must not gain a dependency on it.
 */

export type RouterAdapterShapeSource = 'models_catalog' | 'chat_completion';

/** Thrown when an upstream Orbio response is missing a field the router depends on (e.g. `/models`
 *  with no parseable `data[].pricing`, or a non-stream completion with no `usage`). The route
 *  handler decides per-source what to do with it — for a missing `usage` on a non-stream chat
 *  completion, the ticket specifies the response is still returned to the caller and the call is
 *  recorded with `status: "no_usage"`, so this error is logged (redacted), not thrown onward to
 *  crash the request. */
export class AdapterShapeError extends Error {
  readonly source: RouterAdapterShapeSource;
  /** Deep-redacted copy of the offending value — safe to log. Never the raw value. */
  readonly redactedSample: unknown;

  constructor(source: RouterAdapterShapeSource, issues: string, redactedSample: unknown) {
    super(`AdapterShapeError: ${source} returned an unrecognized shape: ${issues}`);
    this.name = 'AdapterShapeError';
    this.source = source;
    this.redactedSample = redactedSample;
  }
}
