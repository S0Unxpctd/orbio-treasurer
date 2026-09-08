/**
 * redact() — deep-walks any value and masks secret-shaped strings to `<prefix>…<last4>`.
 *
 * Rules (see PRD §11, FR-2.1, tasks/T-003.md):
 *  - Orbio/OpenRouter keys (`sk-or-...`)      -> `sk-or-…<last4>`
 *  - generic gateway keys (`sk-...`)          -> `sk-…<last4>`
 *  - `Bearer <token>`                          -> `Bearer <masked-token>`
 *  - JWT-looking `xxx.yyy.zzz` base64url       -> `<first4>…<last4>`
 *  - 0x-prefixed 64-hex private keys           -> `0x…<last4>` (fully masked)
 *  - long opaque blobs (>=32 [A-Za-z0-9_-])    -> `<first4>…<last4>`
 *  - object keys ending in _KEY/_SECRET/_TOKEN/_PK/_PASSWORD -> whole value masked, any shape
 *
 * Explicitly NOT masked: normal words, short ids, 0x…40-hex addresses (public), UUIDs,
 * ISO dates, plain numbers.
 *
 * Secrets embedded in URLs (query strings, basic-auth userinfo) and inside Error
 * messages/stacks are caught because redaction is a plain string scan — it does not
 * need to understand URL or stack-trace syntax to find a token-shaped substring in one.
 */

const ELLIPSIS = '…';

// --- individual patterns (exported so tests can exercise each one directly) ---
export const REDACTION_PATTERNS = {
  /** Orbio / OpenRouter gateway keys, e.g. sk-or-v1-... */
  openRouterKey: /sk-or-[A-Za-z0-9_-]{6,}/,
  /** Generic `sk-...` style API keys (OpenAI-shaped etc.), not already sk-or- */
  genericSecretKey: /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /** `Bearer <token>` authorization headers */
  bearerToken: /\bBearer\s+([^\s"'<>]+)/i,
  /** JWT-looking base64url triples: header.payload.signature */
  jwt: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /** 0x-prefixed 64-hex-char EVM private keys (NOT 40-hex addresses) */
  privateKeyHex: /\b0x[0-9a-fA-F]{64}\b/,
  /** Long opaque token-shaped blobs (session ids, API secrets without a known prefix) */
  opaqueBlob: /\b[A-Za-z0-9_-]{32,}\b/,
  /** Object keys that always mean "secret", regardless of the value's shape */
  sensitiveKeyName: /(_KEY|_SECRET|_TOKEN|_PK|_PASSWORD)$/i,
} as const;

// Non-global copies for single-shot .test() calls (avoids /g lastIndex statefulness).
const RE_OPEN_ROUTER = new RegExp(REDACTION_PATTERNS.openRouterKey.source);
const RE_GENERIC_SK = new RegExp(REDACTION_PATTERNS.genericSecretKey.source);
const RE_PRIVATE_KEY = new RegExp(REDACTION_PATTERNS.privateKeyHex.source);
const RE_JWT = new RegExp(REDACTION_PATTERNS.jwt.source);

// Global copies for .replace() sweeps over free-form strings.
const RE_BEARER_G = new RegExp(REDACTION_PATTERNS.bearerToken.source, 'gi');
const RE_OPEN_ROUTER_G = new RegExp(REDACTION_PATTERNS.openRouterKey.source, 'g');
const RE_GENERIC_SK_G = new RegExp(REDACTION_PATTERNS.genericSecretKey.source, 'g');
const RE_PRIVATE_KEY_G = new RegExp(REDACTION_PATTERNS.privateKeyHex.source, 'g');
const RE_JWT_G = new RegExp(REDACTION_PATTERNS.jwt.source, 'g');
const RE_OPAQUE_BLOB_G = new RegExp(REDACTION_PATTERNS.opaqueBlob.source, 'g');

// Shapes that must never be masked even though they satisfy the opaque-blob charset/length.
const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RE_ALL_DIGITS = /^[0-9]+$/;

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

/** Masks a value found under a `..._KEY`/`..._SECRET`/etc. object key, whatever its shape. */
function maskWholeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length === 0) return value;
    return maskToken(value);
  }
  if (value === null || value === undefined) return value;
  return '[REDACTED]';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (REDACTION_PATTERNS.sensitiveKeyName.test(key)) {
      result[key] = maskWholeValue(value);
    } else {
      result[key] = redact(value);
    }
  }
  return result;
}

function redactError(err: Error): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: err.name,
    message: redactString(err.message),
  };
  if (typeof err.stack === 'string') {
    result.stack = redactString(err.stack);
  }
  const extraKeys = Object.keys(err).filter(
    (k) => k !== 'name' && k !== 'message' && k !== 'stack',
  );
  for (const key of extraKeys) {
    result[key] = redact((err as unknown as Record<string, unknown>)[key]);
  }
  return result;
}

/**
 * Deep-walks `value` (strings, arrays, plain objects, Error objects) and returns an
 * equivalent structure with every secret-shaped substring masked to `<prefix>…<last4>`.
 * Non-string primitives (numbers, booleans, null, undefined, bigint) and non-plain
 * objects (Date, RegExp, Map, Set, …) pass through unchanged.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value instanceof Error) return redactError(value);
  if (isPlainObject(value)) return redactObject(value);
  return value;
}
