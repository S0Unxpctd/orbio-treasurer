/**
 * Small transaction-shaped helpers shared across `chain/` write modules (S-04, tasks/S-04.md
 * "In scope": "put shared helpers you need in a new `chain/tx.ts` rather than editing S-05's
 * file"). S-05's `buy.ts` is on its own branch, mid-fix, and is never imported from here or
 * edited by this ticket — every helper below is written fresh for `claim.ts`, even where it
 * duplicates a same-shaped private helper `buy.ts` already has (e.g. its own `utcDateKey`).
 * Nothing here is Orbio/CREDIT-specific beyond the generic "decode one named event, from one
 * expected contract address, out of a transaction receipt" shape both `buy.ts` and `claim.ts`
 * need for the `Activated` event.
 */
import type { Abi, Address, Hex, TransactionReceipt } from 'viem';
import { decodeEventLog } from 'viem';

/** Opaque per-UTC-calendar-day key, built only from `getUTC*` accessors — never a local-time
 *  getter (audit focus carried over from S-05's `buy.ts`: "day counter using local time"). Two
 *  ISO timestamps in the same UTC calendar day produce the same key; a timestamp one second
 *  either side of midnight UTC does not. */
export function utcDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/** Sums the `amount`s of every entry whose `at` falls on `now`'s UTC calendar day — the shared
 *  half of a per-day cap check (`claim.ts`'s `ACTIVATE_MAX_PER_DAY`; `buy.ts`'s per-day count
 *  does the equivalent by counting rows instead of summing amounts, since a buy is always the
 *  same size-checked-elsewhere shape). */
export function sumAtomsForUtcDay(
  entries: readonly { readonly at: string; readonly amount: bigint }[],
  now: Date,
): bigint {
  const todayKey = utcDateKey(now.toISOString());
  return entries.reduce(
    (sum, e) => (utcDateKey(e.at) === todayKey ? sum + e.amount : sum),
    0n as bigint,
  );
}

/** `max(0, cap - usedToday)` — never negative (a cap lowered mid-day by env, or a burst of
 *  concurrent activity, must not turn this into "more room" by wrapping negative). */
export function capRemaining(cap: bigint, usedToday: bigint): bigint {
  const remaining = cap - usedToday;
  return remaining > 0n ? remaining : 0n;
}

/** `bytes32(address, left-padded)` — the exact shape both `Exchange.buyAndActivate`'s and
 *  `CREDIT.activate(amount, beneficiary)`'s `beneficiary` param expect (PRD §3). Implemented
 *  locally (not imported from `buy.ts`) rather than depending on that file, per this ticket's
 *  "do NOT modify buy.ts" — a plain left-pad has no reason to disagree between the two call
 *  sites, but keeping this file independent means a change on the S-05 branch can never
 *  silently affect this ticket's build. */
export function addressToBytes32(address: Address): Hex {
  const hex = address.toLowerCase().replace(/^0x/, '');
  return `0x${'0'.repeat(24)}${hex}` as Hex;
}

/** Throws with `label` in the message if `receipt.status !== 'success'` — the one check every
 *  step of a multi-tx flow needs before trusting its receipt (audit focus: "receipt with status
 *  reverted treated as success"). Never returns anything meaningful on failure; callers just
 *  need this to throw before reading anything else off a reverted receipt. */
export function requireSuccessReceipt(receipt: TransactionReceipt, label: string): void {
  if (receipt.status !== 'success') {
    throw new Error(`${label} reverted (tx ${receipt.transactionHash})`);
  }
}

/**
 * Scans `receipt.logs` for the first log that is BOTH (a) emitted by `contractAddress` and (b)
 * decodes against `abi`'s `eventName` — in that order, so a log from the wrong contract that
 * merely shares a topic0 with the real event is never considered (audit focus carried over from
 * `buy.ts`'s `decodeActivatedEvent`: "event decoding trusting a wrong contract address").
 * Returns `null` if no such log is found; callers treat that as fatal for the step it belongs to.
 */
export function decodeEventFromContract<TArgs = Record<string, unknown>>(
  receipt: TransactionReceipt,
  abi: Abi,
  eventName: string,
  contractAddress: Address,
): TArgs | null {
  for (const receiptLog of receipt.logs) {
    if (receiptLog.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi,
        data: receiptLog.data,
        topics: receiptLog.topics,
        eventName,
      });
      return decoded.args as unknown as TArgs;
    } catch {
      // Not a match for `eventName` on this ABI (wrong topic0, or a different event on the same
      // contract) — keep scanning the rest of the receipt's logs.
    }
  }
  return null;
}

/**
 * Resolves a gwei-denominated env override that has no directionality restriction (unlike a
 * money exposure cap, CLAUDE.md rule 5) — shared shape behind S-05's `resolveMaxFeeGweiCap` and
 * this ticket's own `MAX_FEE_GWEI`/gas-floor reads. Falls back to `fallback` (never throws) on
 * an unset, non-finite or non-positive value, warning once via `warn` when the raw value was
 * present but rejected.
 */
export function resolvePositiveNumberEnv(
  raw: string | undefined,
  fallback: number,
  label: string,
  warn: (message: string) => void,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(
      `${label}="${raw}" is not a valid positive number — ignoring, keeping default ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}
