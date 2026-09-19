/**
 * Wallet-signed Orbio API key derivation, and reading the activated balance behind a key
 * (S-03, docs/PRD-1.0-sprint.md §3, tasks/S-03.md "In scope").
 *
 * `deriveOrbioKey()` never touches the network — it's pure signing. `readApiBalance()` is the
 * one HTTP call in this file (`GET {base}/key`), validated with Zod per CLAUDE.md #6.
 */
import type { Hex } from 'viem';
import { hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { redact } from '../redact.js';
import { AdapterShapeError, GatewayKeyHttpError } from './errors.js';

/** The exact string the ticket specifies, including its two U+00B7 MIDDLE DOT characters (not
 *  U+2022 bullet, not a hyphen) — `deriveOrbioKey()`'s signature must match the gateway's own
 *  derivation byte-for-byte or the key is simply "unknown" to it (verified live, see
 *  docs/api-notes.md "S-03 chain reads": a 401 "unknown or has been revoked", not "malformed"). */
export function orbioKeyDerivationMessage(epoch: number): string {
  return `Orbio API key · chain 4663 · epoch ${epoch}`;
}

/**
 * Signs `orbioKeyDerivationMessage(epoch)` with `privateKey` (EIP-191 personal_sign, via viem's
 * local account — deterministic: the same private key + epoch always produces the same
 * signature and therefore the same key, AC4) and returns `sk-orb-<epoch>-<base64(sig bytes)>`.
 * `privateKey` is never logged here or by any caller that respects CLAUDE.md #4 — `redact()`
 * masks both the `0x`+64-hex private key shape and the derived `sk-orb-` key shape (see
 * redact.test.ts's S-03 additions).
 */
export async function deriveOrbioKey(privateKey: Hex, epoch = 0): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signMessage({ message: orbioKeyDerivationMessage(epoch) });
  const bytes = hexToBytes(signature);
  const body = Buffer.from(bytes).toString('base64');
  return `sk-orb-${epoch}-${body}`;
}

export interface ApiBalance {
  readonly available: string;
  readonly used: string;
}

const keyBalanceResponseSchema = z
  .object({
    balance: z
      .object({
        available: z.string(),
        used: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * `GET {gatewayBaseUrl}/key` with `key` as a Bearer token (PRD §3: `{balance:{currency,
 * available, used}, rate_limit:{...}}`). Throws `GatewayKeyHttpError` (redacted body) on a
 * non-2xx status — a 401 "unknown or revoked" is a legitimate, expected outcome for a key that
 * hasn't been activated (AC4), not a shape problem, so it's kept distinct from
 * `AdapterShapeError` (thrown only for a 2xx body missing `balance.available`/`balance.used`,
 * per CLAUDE.md #6). `key` itself is never included in either error — only the response body,
 * redacted.
 */
export async function readApiBalance(
  gatewayBaseUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiBalance> {
  const res = await fetchImpl(`${gatewayBaseUrl}/key`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) {
      throw new GatewayKeyHttpError(res.status, redact(text.slice(0, 500)));
    }
    throw new AdapterShapeError(
      'gateway_key',
      'response body is not JSON',
      redact(text.slice(0, 500)),
    );
  }
  if (!res.ok) {
    throw new GatewayKeyHttpError(res.status, redact(json));
  }
  const parsed = keyBalanceResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new AdapterShapeError('gateway_key', parsed.error.message, redact(json));
  }
  return { available: parsed.data.balance.available, used: parsed.data.balance.used };
}

/** Extracts the `available` balance (USD) from an `X-Orbio-Balance` response header value, per
 *  the ticket ("Also parse the `X-Orbio-Balance` header helper for S-06") — PRD §3: the header
 *  carries the balance BEFORE the request as a plain decimal string. Returns `null` for an
 *  absent/empty header or one that isn't a plain decimal (never throws — a missing header on a
 *  successful completion is not itself an error worth failing a request over; S-06 decides what
 *  to do with `null`). */
export function parseOrbioBalanceHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
}
