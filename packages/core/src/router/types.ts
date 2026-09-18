/**
 * Shared types for the router package (S-01, docs/PRD-1.0-sprint.md §3, §4 T-1, §6).
 *
 * These types are pure by construction — nothing here does I/O. `route()` in `route.ts` is the
 * package's one function with the strict "no fs/net/Date" requirement (AC1); other files under
 * `router/` (keys, recorder, catalog, upstream) do I/O deliberately and are not held to it.
 */

/** Price-derived routing tiers (PRD §3/§4 T-1: S ≤ $0.40/M input, M ≤ $3/M, L above). */
export const TIERS = ['S', 'M', 'L'] as const;
export type Tier = (typeof TIERS)[number];

/** Policy mode, driving the router's cap (`eco` → cap at M, `critical` → cap at S). Sourced from
 *  `TREASURER_MODE` for this ticket; the tick-derived mode lands in S-06. */
export const MODES = ['normal', 'eco', 'critical'] as const;
export type Mode = (typeof MODES)[number];

/**
 * One entry from Orbio's `GET /models` catalog, the fields the router depends on. `pricing.prompt`
 * / `pricing.completion` are USD **per input/output token** (PRD §3: "GET /models has per-token
 * pricing") — tier buckets are per-million-token, so `priceTier()` multiplies by 1e6.
 */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly pricing: {
    readonly prompt: number;
    readonly completion: number;
  };
}

/** The shape of one OpenAI chat-completion message the router reads (`role` + `content`); it
 *  never reads anything else off a message, so callers can pass their raw request messages
 *  through untouched. */
export interface RouteMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface RouteInput {
  /** The caller's `model` field, verbatim: `"auto"`, `"auto:S"`, `"auto:M"`, `"auto:L"`, or an
   *  exact Orbio model id. */
  readonly requestedModel: string;
  readonly messages: readonly RouteMessage[];
  readonly tools?: unknown;
  readonly responseFormat?: { readonly type?: string } | null;
}

export interface RouteOpts {
  /** `TREASURER_MODE`; default `'normal'` (no cap). */
  readonly mode?: Mode;
  /** `ROUTER_ALLOW`; comma-separated model ids. Undefined/empty = every catalog id allowed. */
  readonly allowList?: readonly string[];
}

export interface RouteResult {
  readonly model: string;
  readonly tier: Tier;
  /** `;`-separated trace of why this model was chosen, e.g. `"rule:tools;cap:eco"`. Always starts
   *  with `"explicit"` for an exact-model request, or a `rule:*` id for an `auto*` request. */
  readonly reason: string;
}

/**
 * Thrown by `route()` for:
 *  - `unknown_model` — an exact (non-`auto*`) `requestedModel` that isn't in the catalog (AC1).
 *  - `no_model_in_tier` — the allowed catalog (after `ROUTER_ALLOW` filtering) has no model in
 *    any tier at all. Never thrown for a non-empty allowed catalog: `route()` falls back to the
 *    nearest non-empty tier first (see `selectModelForTier` in `pricing.ts`).
 */
export class RouterError extends Error {
  readonly code: 'unknown_model' | 'no_model_in_tier';
  constructor(code: 'unknown_model' | 'no_model_in_tier', message: string) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}
