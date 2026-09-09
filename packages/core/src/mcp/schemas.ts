/**
 * Zod schemas for the four Orbio MCP tools (T-010, PRD FR-2.1, CLAUDE.md rule 6,
 * docs/api-notes.md P-1, `fixtures/mcp-tools-2026-09-09.json`).
 *
 * Convention (CLAUDE.md rule 6): unknown/extra fields are tolerated (`.passthrough()`); a
 * *missing required* field is fatal — `parseStructuredContent()` throws a typed
 * `AdapterShapeError` carrying a redacted sample, which `recordUnrecognizedSample()` appends to
 * docs/api-notes.md's "Unrecognized samples" section. Money is read from `*.microUsd` (an exact
 * integer string) per the fixture note — `*.usd` is a float and is never parsed here.
 *
 * `orbio_get_balance` and `orbio_get_key_status` shapes come from the real, dated fixture
 * (P-1, 2026-09-09) and are validated with their one field each caller actually depends on
 * required, everything else tolerated.
 *
 * `orbio_create_key` and `orbio_revoke_key` were never called against the live server — CLAUDE
 * live-call rules forbid it here (a retry would rotate So's production key; see tasks/T-010.md
 * "LIVE CALL RULES"). Their `structuredContent` shape is therefore genuinely unknown: the
 * schemas below require only "is an object", and `client.ts` does not depend on any particular
 * field of it — it extracts the new key secret defensively from `content[0].text` (the one
 * thing the tool description guarantees: "The secret is in this response"). See
 * tasks/T-010.md Discovered.
 */
import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { redact } from '../redact.js';

export const MCP_TOOL_NAMES = [
  'orbio_get_balance',
  'orbio_get_key_status',
  'orbio_create_key',
  'orbio_revoke_key',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Thrown when a tool's `structuredContent` is missing a field the client depends on. Never
 *  swallowed (CLAUDE.md rule 6) — the tick that hits this must fail loudly. */
export class AdapterShapeError extends Error {
  readonly tool: McpToolName;
  /** Deep-redacted copy of the offending value — safe to log, safe to append to
   *  docs/api-notes.md. Never the raw value (it may carry a key/token-shaped string). */
  readonly redactedSample: unknown;

  constructor(tool: McpToolName, issues: string, redactedSample: unknown) {
    super(`AdapterShapeError: ${tool} returned an unrecognized shape: ${issues}`);
    this.name = 'AdapterShapeError';
    this.tool = tool;
    this.redactedSample = redactedSample;
  }
}

/** Exact-integer microUSD string (matches `ledger/decimal.ts`'s token-amount shape — this is a
 *  count of micro-dollars, not a `numeric(18,6)`-scaled money string). */
const microUsdStringSchema = z.string().regex(/^-?\d+$/, 'expected an integer microUSD string');

const microUsdFieldSchema = z.object({ microUsd: microUsdStringSchema }).passthrough();

/** `orbio_get_balance.structuredContent` — fixtures/mcp-tools-2026-09-09.json. Only `balance`
 *  (the "spendable now" figure `getBalance()` reports) is required; `accrued`/`purchased`/
 *  `deposited`/`depositBalance`/`spent`/`claimed`/`depositFrozen`/`wallets` are all tolerated
 *  whether present, absent, or of an unrecognized shape — this client does not read them. */
export const balanceStructuredContentSchema = z
  .object({ balance: microUsdFieldSchema })
  .passthrough();

export type BalanceStructuredContent = z.infer<typeof balanceStructuredContentSchema>;

/** `orbio_get_key_status.structuredContent` — fixtures/mcp-tools-2026-09-09.json. `hasKey` is
 *  the one field policy needs (`KeyStatusInput.valid`, PRD §10); `prefix`/`createdAt`/
 *  `lastUsedAt`/`baseUrl`/`legacy` are tolerated, not required. */
export const keyStatusStructuredContentSchema = z.object({ hasKey: z.boolean() }).passthrough();

export type KeyStatusStructuredContent = z.infer<typeof keyStatusStructuredContentSchema>;

/** `orbio_create_key` / `orbio_revoke_key` — shape genuinely unconfirmed (never called live,
 *  see file header). Requires only that `structuredContent`, if present, is an object; `client.ts`
 *  falls back to `content[0].text` for the parts it needs. */
export const createKeyStructuredContentSchema = z.object({}).passthrough();
export const revokeKeyStructuredContentSchema = z.object({}).passthrough();

/**
 * Validates `value` (a tool's `structuredContent`) against `schema`. Throws `AdapterShapeError`
 * on a missing/invalid required field; unknown extra fields never fail validation.
 */
export function parseStructuredContent<T>(
  tool: McpToolName,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AdapterShapeError(tool, result.error.message, redact(value));
  }
  return result.data;
}

// --- docs/api-notes.md "Unrecognized samples" (CLAUDE.md rule 6) ------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/core/src/mcp -> repo root is four levels up.
const DEFAULT_API_NOTES_PATH = resolve(HERE, '../../../../docs/api-notes.md');

export interface RecordUnrecognizedSampleOptions {
  /** Override for tests — never point this at the real docs/api-notes.md from a test. */
  readonly path?: string;
  readonly now?: () => Date;
}

/**
 * Appends a dated, redacted block for `err` to docs/api-notes.md's "Unrecognized samples"
 * section (CLAUDE.md rule 6: "redacted sample appended ... tick fails loudly"). Best-effort:
 * callers should catch/log a failure here rather than let a docs-append problem mask the
 * original `AdapterShapeError` they are about to (re)throw.
 *
 * `err.message` is passed through `redact()` too (audit-1 Minor), not only `redactedSample`.
 * Today it is safe either way — zod's `safeParse().error.message` only ever describes
 * type/pattern/path, never echoes the received value — but that is an implicit property of a
 * third-party library's error format, not an invariant this module enforces itself; a future
 * zod version, or a schema whose custom `.refine()`/`.transform()` message happens to
 * interpolate the input, would otherwise reintroduce a leak here with nothing to catch it.
 */
export async function recordUnrecognizedSample(
  err: AdapterShapeError,
  options: RecordUnrecognizedSampleOptions = {},
): Promise<void> {
  const path = options.path ?? DEFAULT_API_NOTES_PATH;
  const now = options.now ?? (() => new Date());
  const date = now().toISOString().slice(0, 10);
  const block =
    `\n- **${date} · ${err.tool}** (T-010 \`AdapterShapeError\`, auto-appended): ${redact(err.message)}\n` +
    '  ```json\n' +
    `  ${JSON.stringify(err.redactedSample)}\n` +
    '  ```\n';
  await appendFile(path, block, 'utf8');
}
