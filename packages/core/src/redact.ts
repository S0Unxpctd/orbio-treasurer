/**
 * redact() — deep-walks any value and masks secret-shaped strings to `<prefix>…<last4>`.
 *
 * Rules (see PRD §11, FR-2.1, tasks/T-003.md):
 *  - Orbio/OpenRouter keys (`sk-or-...`, any case)   -> `sk-or-…<last4>`
 *  - generic gateway keys (`sk-...`, any case)        -> `sk-…<last4>`
 *  - `Bearer <token>`                                  -> `Bearer <masked-token>`
 *  - JWT-looking `xxx.yyy.zzz` base64url               -> `<first4>…<last4>`
 *  - 0x-prefixed 64-hex private keys                   -> `0x…<last4>` (fully masked)
 *  - long opaque blobs (>=32 [A-Za-z0-9_-])            -> `<first4>…<last4>`
 *  - object keys ending in _KEY/_SECRET/_TOKEN/_PK/_PASSWORD, or a camelCase/any-case
 *    name ending in apiKey/secret/token/password/passwd/privateKey/mnemonic/seed/pk
 *    -> whole value masked, any shape (string, number, object, array, Buffer, …)
 *
 * Explicitly NOT masked: normal words, short ids, 0x…40-hex addresses (public), UUIDs,
 * ISO dates, plain numbers.
 *
 * Secrets embedded in URLs (query strings, basic-auth userinfo) and inside Error
 * messages/stacks/`cause` chains are caught because redaction is a plain string scan —
 * it does not need to understand URL or stack-trace syntax to find a token-shaped
 * substring in one.
 *
 * Non-plain values never pass through unmasked: class instances are walked like plain
 * objects (own enumerable props), Map/Set are walked entry-by-entry, Buffer/TypedArray/
 * ArrayBuffer become `<bytes:N>` (raw bytes are never emitted — a private key is
 * routinely a Buffer/Uint8Array in ethers.js/viem/web3.js), BigInt is stringified, Date
 * becomes its ISO string, and functions/symbols become `<fn>`. Circular references are
 * tracked with a WeakSet and replaced with `<circular>` instead of throwing.
 *
 * ## 0x + 64-hex ambiguity: private key vs. transaction hash
 * A private key and a transaction hash are both, by shape, `0x` followed by 64 hex
 * characters — there is no way to tell them apart from the string alone. This module
 * resolves the ambiguity by failing closed: **every** 0x+64-hex string is masked by
 * default, including a harmless, publicly-verifiable tx hash. PRD §12 wants every
 * on-site figure to link to an explorer, so over-masking a tx hash in a log line is a
 * real but acceptable cost — a private key slipping through unmasked is not.
 * A call site that knows a particular value is a public hash can opt it out of masking
 * via `redact(value, { allowTxHashKeys: [...] })` — see `DEFAULT_ALLOW_TX_HASH_KEYS`,
 * which is what `log.ts` uses by default. The exemption is deliberately narrow, on
 * both axes, so a key-name mix-up can't turn it into a general bypass:
 *   - **key name**: must equal (case-insensitively) one of `allowTxHashKeys` exactly —
 *     no substring/prefix/suffix matching.
 *   - **value shape**: must itself be a string matching `/^0x[0-9a-f]{64}$/i` exactly —
 *     the *whole* value, not merely containing a match.
 * A value that fails either check is never exempted and goes through the normal
 * pipeline instead: a string gets the full `sk-*`/`Bearer`/JWT/opaque-blob scan, and a
 * non-string (object, array, …) is recursed into as usual — so `{ txHash: apiKey }` or
 * `{ txHash: { apiKey } }` are both still fully redacted. This is intentionally an
 * allow-list on key name AND shape together, never on key name alone: trusting the key
 * name for an arbitrary value would let a copy-paste bug or a merged upstream field
 * (e.g. a content hash or password hash also happening to be called `hash`) print a
 * secret verbatim with no caller-visible signal.
 *
 * ## Known, accepted gap
 * A secret split across whitespace/newlines (e.g. word-wrapped output, a mangled env
 * var) is only masked on the fragment that still matches a pattern — the module does
 * not attempt to reassemble whitespace-broken tokens. Low real-world likelihood; not
 * worth the false-positive risk of stitching arbitrary text back together.
 */

const ELLIPSIS = '…';

/** Object keys whose value `log.ts` leaves unmasked by default — see the ambiguity note above. */
export const DEFAULT_ALLOW_TX_HASH_KEYS = [
  'txHash',
  'transactionHash',
  'tx_hash',
  'transaction_hash',
] as const;

export interface RedactOptions {
  /**
   * Object keys (matched case-insensitively, exact match only) whose value is left
   * completely untouched — but ONLY when that value is itself a string matching
   * `/^0x[0-9a-f]{64}$/i`. Any other key name, or any value under a matching key that
   * isn't exactly that shape (a different string, an object, an array, …), is never
   * exempted and goes through normal redaction/recursion instead. See the ambiguity
   * note above.
   */
  allowTxHashKeys?: readonly string[];
}

// --- individual patterns (exported so tests can exercise each one directly) ---
export const REDACTION_PATTERNS = {
  /** Orbio / OpenRouter gateway keys, e.g. sk-or-v1-... (any case) */
  openRouterKey: /sk-or-[A-Za-z0-9_-]{6,}/i,
  /** Generic `sk-...` style API keys (OpenAI-shaped etc.), not already sk-or- (any case) */
  genericSecretKey: /\bsk-[A-Za-z0-9_-]{10,}\b/i,
  /** `Bearer <token>` authorization headers */
  bearerToken: /\bBearer\s+([^\s"'<>]+)/i,
  /** JWT-looking base64url triples: header.payload.signature */
  jwt: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /** 0x-prefixed 64-hex-char EVM private keys (NOT 40-hex addresses) */
  privateKeyHex: /\b0x[0-9a-fA-F]{64}\b/,
  /** Long opaque token-shaped blobs (session ids, API secrets without a known prefix) */
  opaqueBlob: /\b[A-Za-z0-9_-]{32,}\b/,
  /** SCREAMING_SNAKE / snake_case object keys that always mean "secret" */
  sensitiveKeyName: /(_KEY|_SECRET|_TOKEN|_PK|_PASSWORD)$/i,
  /** camelCase / any-case object keys that always mean "secret" */
  sensitiveKeyNameCamel:
    /(api[_-]?key|secret|token|password|passwd|private[_-]?key|mnemonic|seed|pk)$/i,
} as const;

function toGlobal(re: RegExp): RegExp {
  return new RegExp(re.source, `${re.flags}g`);
}

// Non-global copies for single-shot .test()/.replace() calls (avoids /g lastIndex bugs).
const RE_OPEN_ROUTER = REDACTION_PATTERNS.openRouterKey;
const RE_GENERIC_SK = REDACTION_PATTERNS.genericSecretKey;
const RE_PRIVATE_KEY = REDACTION_PATTERNS.privateKeyHex;
const RE_JWT = REDACTION_PATTERNS.jwt;

// Global copies for .replace() sweeps over free-form strings.
const RE_BEARER_G = toGlobal(REDACTION_PATTERNS.bearerToken);
const RE_OPEN_ROUTER_G = toGlobal(REDACTION_PATTERNS.openRouterKey);
const RE_GENERIC_SK_G = toGlobal(REDACTION_PATTERNS.genericSecretKey);
const RE_PRIVATE_KEY_G = toGlobal(REDACTION_PATTERNS.privateKeyHex);
const RE_JWT_G = toGlobal(REDACTION_PATTERNS.jwt);
const RE_OPAQUE_BLOB_G = toGlobal(REDACTION_PATTERNS.opaqueBlob);

// Shapes that must never be masked even though they satisfy the opaque-blob charset/length.
const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RE_ALL_DIGITS = /^[0-9]+$/;
// The exact shape allowTxHashKeys is permitted to exempt — see RedactOptions above.
const RE_ALLOWED_HASH_SHAPE = /^0x[0-9a-f]{64}$/i;

function maskPrefixLast4(raw: string, prefixLen: number): string {
  const prefix = raw.slice(0, prefixLen);
  if (raw.length <= prefixLen + 4) {
    return `${prefix}${ELLIPSIS}`;
  }
  return `${prefix}${ELLIPSIS}${raw.slice(-4)}`;
}

function isBlobExempt(candidate: string): boolean {
  return RE_UUID.test(candidate) || RE_ETH_ADDRESS.test(candidate) || RE_ALL_DIGITS.test(candidate);
}

/** Best-effort mask for a single already-isolated token (used for Bearer <token>). */
function maskToken(token: string): string {
  if (RE_OPEN_ROUTER.test(token)) {
    return token.replace(RE_OPEN_ROUTER, (m) => maskPrefixLast4(m, 6));
  }
  if (RE_GENERIC_SK.test(token)) {
    return token.replace(RE_GENERIC_SK, (m) => maskPrefixLast4(m, 3));
  }
  if (RE_PRIVATE_KEY.test(token)) {
    return token.replace(RE_PRIVATE_KEY, (m) => maskPrefixLast4(m, 2));
  }
  if (RE_JWT.test(token)) {
    return token.replace(RE_JWT, (m) => maskPrefixLast4(m, 4));
  }
  if (token.length >= 32) {
    return isBlobExempt(token) ? token : maskPrefixLast4(token, 4);
  }
  if (token.length > 4) {
    return maskPrefixLast4(token, 0);
  }
  return '<redacted>';
}

/** Scans free-form text and masks every secret-shaped substring it finds. */
function redactString(input: string): string {
  let out = input;
  out = out.replace(RE_BEARER_G, (_m, tok: string) => `Bearer ${maskToken(tok)}`);
  out = out.replace(RE_OPEN_ROUTER_G, (m) => maskPrefixLast4(m, 6));
  out = out.replace(RE_GENERIC_SK_G, (m) => maskPrefixLast4(m, 3));
  out = out.replace(RE_PRIVATE_KEY_G, (m) => maskPrefixLast4(m, 2));
  out = out.replace(RE_JWT_G, (m) => maskPrefixLast4(m, 4));
  out = out.replace(RE_OPAQUE_BLOB_G, (m) => (isBlobExempt(m) ? m : maskPrefixLast4(m, 4)));
  return out;
}

/** Masks a value found under a sensitive-shaped object key, whatever its shape. */
function maskWholeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length === 0 ? value : maskToken(value);
  }
  if (value === null || value === undefined) return value;
  return '[REDACTED]';
}

function isSensitiveKeyName(key: string): boolean {
  return (
    REDACTION_PATTERNS.sensitiveKeyName.test(key) ||
    REDACTION_PATTERNS.sensitiveKeyNameCamel.test(key)
  );
}

/**
 * True only when BOTH: `key` exactly matches (case-insensitively) an entry in
 * `options.allowTxHashKeys`, AND `value` is itself a string matching
 * `/^0x[0-9a-f]{64}$/i` exactly. Anything else — a wrong key name, a non-string value,
 * or a string that isn't precisely that shape — is never exempted.
 */
function isExemptTxHashValue(key: string, value: unknown, options: RedactOptions): boolean {
  const list = options.allowTxHashKeys;
  if (!list || list.length === 0) return false;
  if (typeof value !== 'string' || !RE_ALLOWED_HASH_SHAPE.test(value)) return false;
  const lowerKey = key.toLowerCase();
  return list.some((allowed) => allowed.toLowerCase() === lowerKey);
}

function isBinaryLike(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function binaryByteLength(value: ArrayBuffer | ArrayBufferView): number {
  return value.byteLength;
}

function redactError(
  err: Error,
  options: RedactOptions,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: err.name,
    message: redactString(err.message),
  };
  if (typeof err.stack === 'string') {
    result.stack = redactString(err.stack);
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    result.cause = redact(cause, options, seen);
  }
  const alreadyHandled = new Set(['name', 'message', 'stack', 'cause']);
  for (const key of Object.getOwnPropertyNames(err)) {
    if (alreadyHandled.has(key)) continue;
    result[key] = redact((err as unknown as Record<string, unknown>)[key], options, seen);
  }
  return result;
}

/** Walks a plain object literal or a class instance's own enumerable properties. */
function redactContainer(
  obj: Record<string, unknown>,
  options: RedactOptions,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (isExemptTxHashValue(key, value, options)) {
      result[key] = value;
      continue;
    }
    if (isSensitiveKeyName(key)) {
      result[key] = maskWholeValue(value);
      continue;
    }
    result[key] = redact(value, options, seen);
  }
  return result;
}

/**
 * Deep-walks `value` and returns an equivalent, JSON-safe structure with every
 * secret-shaped substring masked to `<prefix>…<last4>`. See the file header for the
 * full rule set, the `allowTxHashKeys` escape hatch, and what happens to non-plain
 * values (class instances, Map/Set, Buffer/TypedArray/ArrayBuffer, BigInt, Date,
 * functions/symbols) and circular references. Never throws.
 */
export function redact(
  value: unknown,
  options: RedactOptions = {},
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return '<fn>';
    case 'boolean':
    case 'number':
      return value;
    default:
      break;
  }

  // `value` is a non-null `object` from here on.
  if (value instanceof Date) return value.toISOString();
  if (isBinaryLike(value)) return `<bytes:${binaryByteLength(value)}>`;

  if (seen.has(value)) return '<circular>';
  seen.add(value);

  if (value instanceof Error) return redactError(value, options, seen);
  if (Array.isArray(value)) return value.map((item) => redact(item, options, seen));
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([k, v]) => [
      redact(k, options, seen),
      redact(v, options, seen),
    ]);
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((v) => redact(v, options, seen));
  }

  // Anything else that's still an object: a plain object literal or a class instance.
  return redactContainer(value as Record<string, unknown>, options, seen);
}
