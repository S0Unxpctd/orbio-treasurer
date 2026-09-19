#!/usr/bin/env tsx
/**
 * P-7b · USDG → ORBIO swap route on chain 4663 (read-only, no tx, no private key)
 * tasks/P-7b.md, docs/PRD-1.0-sprint.md §3/§4 T-7.
 *
 * Question: is there a callable, quotable on-chain route to buy ORBIO with USDG on Robinhood
 * Chain that our hot wallet can use from viem, and what are the exact contract addresses?
 *
 * Method (matches tasks/P-7b.md "Method" section):
 *   1. `Staking.addresses()` (verified selector, 7 addresses) — actual live read.
 *   2. Extract every 20-byte address constant from `Payout`'s runtime bytecode
 *      (`eth_getCode`), via a proper single-pass EVM disassembly that skips PUSH-immediate
 *      bytes instead of a blind regex (so we never misread mid-push data as an opcode).
 *      Looks for PUSH20 (0x73) literals and zero-padded PUSH32 (0x7f) literals (the two
 *      shapes Solidity actually emits for an embedded address constant).
 *   3. Every candidate address (bytecode constants ∪ Staking.addresses() ∪ known PRD §3
 *      addresses) gets `eth_getCode` (EOA vs contract, code size) then a selector probe:
 *        - zero-arg view getters (`poolManager()`, `WETH9()`, `factory()`, `owner()`, …) are
 *          *actually called* via `eth_call` — a real read, not a guess.
 *        - arg-taking selectors we can't safely guess arguments for
 *          (`execute(bytes,bytes[])`, `unlock(bytes)`, `quoteExactInputSingle(...)`) are
 *          checked for a PUSH4-selector literal in the runtime bytecode's dispatch table —
 *          weaker evidence ("this contract *could* implement it"), always labelled as such.
 *        - `extsload(bytes32)` and `getSlot0(bytes32)` / `getLiquidity(bytes32)` *are*
 *          actually called (zero-arg-shaped: one bytes32 slot/poolId), since a dummy argument
 *          is harmless for a view function and tells us whether the selector exists for real.
 *   4. If a StateView/PoolManager-shaped contract responds, read slot0/liquidity for the known
 *      ORBIO/NVDA pool id (docs/api-notes.md "P-7", supplied by So 2026-09-08) and for computed
 *      NVDA/USDG candidate pool ids at fee ∈ {0, 500, 3000, 10000} (default tick spacing per
 *      fee tier per Uniswap v4 convention), hooks = 0x0.
 *
 * Output: JSON lines to stdout (one per finding), redact()-safe (no secrets ever touched —
 * this script never has a private key). Paste the printed table into docs/api-notes.md.
 *
 * Usage: `pnpm probe P-7b` or `tsx scripts/probes/p7b-swap-route.ts`
 */
import {
  type Address,
  concatHex,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  pad,
  toFunctionSelector,
  toHex,
} from 'viem';
import { createRobinhoodClient, DEFAULT_RH_RPC_URLS } from '../../packages/core/src/chain/chain.js';
import { stakingAbi } from '../../packages/core/src/chain/contracts.js';

// ---------------------------------------------------------------------------
// Known facts (PRD §3, docs/api-notes.md "P-7") — read-only cross-reference labels, not new
// claims. Never a source of truth for a live call's correctness.
// ---------------------------------------------------------------------------

interface KnownAddresses {
  readonly CREDIT: Address;
  readonly STAKING: Address;
  readonly EXCHANGE: Address;
  readonly PAYOUT: Address;
  readonly ORBIO: Address;
  readonly USDG: Address;
  readonly NVDA: Address;
}

const KNOWN: KnownAddresses = {
  CREDIT: getAddress('0xe33322da1380e61e5ae5dfb21e7f62924c73004c'),
  STAKING: getAddress('0xe0710011278bfb63e57c5f227e5980984b1eddca'),
  EXCHANGE: getAddress('0x6951ffd32630b05e06f50062aea801625a58ebc0'),
  PAYOUT: getAddress('0x4cbbbf652b11ed1294df0ac49d8322394310cfc5'),
  ORBIO: getAddress('0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3'),
  USDG: getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  NVDA: getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'),
};

// docs/api-notes.md "P-7 · Stake pool" (2026-09-08): So-supplied Uniswap v4 pool id, ORBIO/NVDA.
const KNOWN_ORBIO_NVDA_POOL_ID: Hex =
  '0xa95b1fbdccb15d2b07509b980f63adab8a94303b1781f5ebc53b72942d12ddc1';

// Canonical Uniswap v4 core deployment addresses (same on every chain that has an official
// deployment via the deterministic deployer). PRD §3 already says these have no code on 4663;
// checked again here for the record.
const CANONICAL_V4_POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const CANONICAL_UNIVERSAL_ROUTER_V4 = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';

function logLine(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

// ---------------------------------------------------------------------------
// Step 1 — proper single-pass EVM disassembly to extract PUSH20/PUSH32 address constants.
// A blind regex over the hex string would misread bytes that happen to fall *inside* a
// previous PUSH's immediate data as if they were opcodes; walking opcode-by-opcode and
// skipping immediate bytes avoids that.
// ---------------------------------------------------------------------------

interface ExtractedConstant {
  address: Address;
  offset: number;
  pushSize: 20 | 32;
}

function extractAddressConstants(codeHex: Hex): ExtractedConstant[] {
  const hex = codeHex.slice(2);
  const bytes = Buffer.from(hex, 'hex');
  const found: ExtractedConstant[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i] as number;
    if (op >= 0x60 && op <= 0x7f) {
      // PUSH1 (0x60) .. PUSH32 (0x7f): immediate length = op - 0x5f
      const len = op - 0x5f;
      const start = i + 1;
      const end = start + len;
      if (end <= bytes.length) {
        const imm = bytes.subarray(start, end);
        if (len === 20) {
          const addrHex = `0x${imm.toString('hex')}` as Address;
          found.push({ address: getAddress(addrHex), offset: i, pushSize: 20 });
        } else if (len === 32) {
          // Immutable address stored as a full 32-byte word: only a candidate if the high
          // 12 bytes are zero (i.e. it's actually a right-aligned 20-byte value) and the low
          // 20 bytes aren't all-zero (not just a zeroed slot).
          const high = imm.subarray(0, 12);
          const low = imm.subarray(12, 32);
          if (high.every((b) => b === 0) && !low.every((b) => b === 0)) {
            const addrHex = `0x${low.toString('hex')}` as Address;
            found.push({ address: getAddress(addrHex), offset: i, pushSize: 32 });
          }
        }
      }
      i = end;
    } else {
      i += 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Step 2 — label a candidate address: known-PRD-address match, code size, and selector probe.
// ---------------------------------------------------------------------------

type Client = ReturnType<typeof createRobinhoodClient>;

interface Signal {
  kind: 'call' | 'bytecode-literal';
  sig: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const ZERO_ARG_GETTERS = [
  'poolManager()',
  'WETH9()',
  'factory()',
  'positionManager()',
  'permit2()',
  'owner()',
  'token0()',
  'token1()',
] as const;

// Selectors we probe by bytecode literal only (unsafe/unknown args to actually call).
const LITERAL_ONLY_SELECTORS = [
  'execute(bytes,bytes[])',
  'execute(bytes,bytes[],uint256)',
  'unlock(bytes)',
] as const;

async function probeZeroArgGetter(client: Client, address: Address, sig: string): Promise<Signal> {
  const selector = toFunctionSelector(sig);
  try {
    const data = await client.call({ to: address, data: selector });
    return { kind: 'call', sig, ok: true, value: data.data };
  } catch (err) {
    return {
      kind: 'call',
      sig,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeSlotArgGetter(
  client: Client,
  address: Address,
  sig: string,
  slot: Hex,
): Promise<Signal> {
  const selector = toFunctionSelector(sig);
  const data = concatHex([selector, slot]);
  try {
    const res = await client.call({ to: address, data });
    return { kind: 'call', sig, ok: true, value: res.data };
  } catch (err) {
    return {
      kind: 'call',
      sig,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeBytecodeLiteral(codeHex: Hex, sig: string): Signal {
  const selector = toFunctionSelector(sig).slice(2); // strip 0x, 4 bytes = 8 hex chars
  const pushSelectorPattern = `63${selector}`; // PUSH4 (0x63) + selector — Solidity dispatch table
  const present = codeHex.toLowerCase().includes(pushSelectorPattern.toLowerCase());
  return { kind: 'bytecode-literal', sig, ok: present };
}

interface Labelled {
  address: Address;
  knownAs: string | null;
  hasCode: boolean;
  codeSize: number;
  signals: Signal[];
}

async function labelAddress(client: Client, address: Address): Promise<Labelled> {
  const knownAs = Object.entries(KNOWN).find(([, a]) => isAddressEqual(a, address))?.[0] ?? null;
  const code = await client.getCode({ address });
  if (!code || code === '0x') {
    return { address, knownAs, hasCode: false, codeSize: 0, signals: [] };
  }
  const codeSize = (code.length - 2) / 2;
  const signals: Signal[] = [];
  for (const sig of ZERO_ARG_GETTERS) {
    signals.push(await probeZeroArgGetter(client, address, sig));
  }
  for (const sig of LITERAL_ONLY_SELECTORS) {
    signals.push(probeBytecodeLiteral(code, sig));
  }
  // extsload(bytes32) / getSlot0(bytes32) / getLiquidity(bytes32) — safe to actually call with
  // a dummy slot (0x0) as an existence probe; a real slot is used only for the found-contract
  // follow-up below.
  const zeroSlot = `0x${'0'.repeat(64)}` as const;
  signals.push(await probeSlotArgGetter(client, address, 'extsload(bytes32)', zeroSlot));
  signals.push(await probeSlotArgGetter(client, address, 'getSlot0(bytes32)', zeroSlot));
  signals.push(await probeSlotArgGetter(client, address, 'getLiquidity(bytes32)', zeroSlot));
  return { address, knownAs, hasCode: true, codeSize, signals };
}

// ---------------------------------------------------------------------------
// Step 3 — Uniswap v4 pool id computation for NVDA/USDG candidates, if a PoolManager-shaped
// contract is found. PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing,
// hooks)) with currency0/currency1 sorted ascending by address (v4 convention), hooks = 0x0.
// ---------------------------------------------------------------------------

const FEE_TIER_DEFAULT_TICK_SPACING: Record<number, number> = {
  0: 1, // fee-less pools have no canonical default; 1 is the minimum, tried as a guess
  500: 10,
  3000: 60,
  10000: 200,
};

// v4-periphery `StateView.sol`'s own constant (`POOLS_SLOT = bytes32(uint256(6))`) — PoolManager
// has no getSlot0/getLiquidity itself (only StateView does, by calling extsload on PoolManager
// with this computed slot); tried directly here since no separate StateView contract turned up
// among the candidates. `Pool.State` layout: slot0 (offset 0), feeGrowthGlobal0X128 (+1),
// feeGrowthGlobal1X128 (+2), liquidity (+3, packed uint128). UNVERIFIED against this specific
// (non-canonical) deployment — flagged as such in every log line that uses it; a match against
// a plausible sqrtPriceX96 is corroborating evidence, not proof, and a zero/garbage result does
// not prove the pool doesn't exist (the slot constant could differ in a customized deployment).
const POOLS_SLOT = 6n;

function poolStateBaseSlot(poolId: Hex): Hex {
  // keccak256(abi.encodePacked(poolId, POOLS_SLOT)) — encodePacked of two bytes32-shaped values
  // is just their concatenation, so this is keccak256(poolId ++ uint256(6)).
  return keccak256(concatHex([poolId, pad(toHex(POOLS_SLOT), { size: 32 })]));
}

function addSlot(base: Hex, offset: number): Hex {
  return pad(toHex(BigInt(base) + BigInt(offset)), { size: 32 });
}

function decodeSlot0(word: Hex): {
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
} {
  // Slot0 packs, from the low bits up: sqrtPriceX96 (160 bits) | tick (24 bits, signed) |
  // protocolFee (24 bits) | lpFee (24 bits) — v4-core `Slot0.sol`'s bit layout.
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  const tickRaw = (v >> 160n) & 0xffffffn;
  const tick = tickRaw >= 0x800000n ? Number(tickRaw - 0x1000000n) : Number(tickRaw);
  const protocolFee = Number((v >> 184n) & 0xffffffn);
  const lpFee = Number((v >> 208n) & 0xffffffn);
  return { sqrtPriceX96: sqrtPriceX96.toString(), tick, protocolFee, lpFee };
}

function computePoolId(tokenA: Address, tokenB: Address, fee: number, tickSpacing: number): Hex {
  const [currency0, currency1] =
    BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  const encoded = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
    ],
    [currency0, currency1, fee, tickSpacing, '0x0000000000000000000000000000000000000000'],
  );
  return keccak256(encoded);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = createRobinhoodClient([...DEFAULT_RH_RPC_URLS]);
  logLine({ step: 'start', rpcUrls: DEFAULT_RH_RPC_URLS, chainId: await client.getChainId() });

  // 1. Staking.addresses() — live read, verified selector per PRD §3.
  let stakingAddresses: readonly Address[] = [];
  try {
    const raw = await client.readContract({
      address: KNOWN.STAKING,
      abi: stakingAbi,
      functionName: 'addresses',
    });
    stakingAddresses = (raw as Address[]).map((a) => getAddress(a));
    logLine({ step: 'staking.addresses()', ok: true, addresses: stakingAddresses });
  } catch (err) {
    logLine({ step: 'staking.addresses()', ok: false, error: String(err) });
  }

  // 2. Payout bytecode extraction.
  const payoutCode = await client.getCode({ address: KNOWN.PAYOUT });
  if (!payoutCode || payoutCode === '0x') {
    logLine({ step: 'payout.getCode', ok: false, note: 'no code at PAYOUT_ADDRESS' });
  } else {
    logLine({ step: 'payout.getCode', ok: true, sizeBytes: (payoutCode.length - 2) / 2 });
  }
  const extracted = payoutCode && payoutCode !== '0x' ? extractAddressConstants(payoutCode) : [];
  const dedupedExtracted = [...new Set(extracted.map((e) => e.address))] as Address[];
  logLine({
    step: 'payout.extractAddressConstants',
    count: dedupedExtracted.length,
    addresses: dedupedExtracted,
    detail: extracted,
  });

  // Also try canonical Uniswap v4 addresses directly (PRD §3 already says "no code"; recheck).
  const canonicalCandidates: Address[] = [
    getAddress(CANONICAL_V4_POOL_MANAGER),
    getAddress(CANONICAL_UNIVERSAL_ROUTER_V4),
  ];

  // 3. Union of every candidate address worth labelling.
  const candidateSet = new Map<string, Address>();
  for (const a of [
    ...dedupedExtracted,
    ...stakingAddresses,
    ...canonicalCandidates,
    ...Object.values(KNOWN),
  ]) {
    candidateSet.set(a.toLowerCase(), a);
  }

  const labelled: Labelled[] = [];
  for (const address of candidateSet.values()) {
    const result = await labelAddress(client, address);
    labelled.push(result);
    logLine({ step: 'label', ...result });
  }

  // 4. If any candidate positively answers getSlot0/extsload (PoolManager/StateView-shaped),
  // read the known ORBIO/NVDA pool id and computed NVDA/USDG candidates.
  const stateViewLike = labelled.filter((l) =>
    l.signals.some((s) => s.sig === 'getSlot0(bytes32)' && s.ok && s.value && s.value !== '0x'),
  );
  const poolManagerLike = labelled.filter((l) =>
    l.signals.some((s) => s.sig === 'extsload(bytes32)' && s.ok && s.value && s.value !== '0x'),
  );
  logLine({
    step: 'v4-shape-summary',
    stateViewLikeCount: stateViewLike.length,
    stateViewLikeAddresses: stateViewLike.map((l) => l.address),
    poolManagerLikeCount: poolManagerLike.length,
    poolManagerLikeAddresses: poolManagerLike.map((l) => l.address),
  });

  // 4b. No separate StateView found (typical — PoolManager itself has no getSlot0/getLiquidity,
  // only `extsload`). If a PoolManager-shaped contract was found, read slot0/liquidity directly
  // via the computed Pool.State storage slot (UNVERIFIED formula, see poolStateBaseSlot()).
  if (poolManagerLike.length > 0) {
    for (const pm of poolManagerLike) {
      const poolIdsToTry: Array<{ label: string; poolId: Hex }> = [
        { label: 'known ORBIO/NVDA (So, 2026-09-08)', poolId: KNOWN_ORBIO_NVDA_POOL_ID },
      ];
      for (const [fee, tickSpacing] of Object.entries(FEE_TIER_DEFAULT_TICK_SPACING)) {
        poolIdsToTry.push({
          label: `computed NVDA/USDG fee=${fee} tickSpacing=${tickSpacing}`,
          poolId: computePoolId(KNOWN.NVDA, KNOWN.USDG, Number(fee), tickSpacing),
        });
      }
      for (const { label, poolId } of poolIdsToTry) {
        const baseSlot = poolStateBaseSlot(poolId);
        const slot0Res = await probeSlotArgGetter(
          client,
          pm.address,
          'extsload(bytes32)',
          baseSlot,
        );
        const liquidityRes = await probeSlotArgGetter(
          client,
          pm.address,
          'extsload(bytes32)',
          addSlot(baseSlot, 3),
        );
        const decoded =
          slot0Res.ok &&
          typeof slot0Res.value === 'string' &&
          slot0Res.value !== `0x${'0'.repeat(64)}`
            ? decodeSlot0(slot0Res.value as Hex)
            : null;
        logLine({
          step: 'extsload(computed Pool.State slot, UNVERIFIED POOLS_SLOT=6 formula)',
          poolManager: pm.address,
          label,
          poolId,
          baseSlot,
          slot0Raw: slot0Res.value ?? null,
          slot0Decoded: decoded,
          liquidityRaw: liquidityRes.value ?? null,
        });
      }
    }
  }

  if (stateViewLike.length > 0) {
    for (const sv of stateViewLike) {
      const known = await probeSlotArgGetter(
        client,
        sv.address,
        'getSlot0(bytes32)',
        KNOWN_ORBIO_NVDA_POOL_ID,
      );
      logLine({ step: 'getSlot0(known ORBIO/NVDA poolId)', address: sv.address, ...known });
      for (const [fee, tickSpacing] of Object.entries(FEE_TIER_DEFAULT_TICK_SPACING)) {
        const poolId = computePoolId(KNOWN.NVDA, KNOWN.USDG, Number(fee), tickSpacing);
        const res = await probeSlotArgGetter(client, sv.address, 'getSlot0(bytes32)', poolId);
        logLine({
          step: 'getSlot0(computed NVDA/USDG poolId)',
          address: sv.address,
          fee,
          tickSpacing,
          poolId,
          ...res,
        });
      }
    }
  } else {
    logLine({
      step: 'getSlot0',
      ok: false,
      note: 'no StateView-shaped contract found among candidates',
    });
  }

  logLine({ step: 'done' });
}

main().catch((err) => {
  logLine({
    step: 'fatal',
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exitCode = 1;
});
