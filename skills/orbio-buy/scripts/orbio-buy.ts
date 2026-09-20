#!/usr/bin/env tsx
/**
 * orbio-buy — buy Orbio CREDIT only when the NET discount clears a target.
 *
 * Net, not gross. Two fees apply and they compound:
 *   1. book fee      Exchange.feeBps()          taken out of usdgIn
 *   2. activation fee CREDIT.activationFeeBps() kept from the CREDIT bought
 * Measured on chain 4663, 2026-09-20: gross 18.40%, net 14.11%. A skill that
 * quotes gross overstates the discount by ~4.3 points.
 *
 * Addresses come from env, never literals (CLAUDE.md #5). See SKILL.md for the
 * published values to put in .env.
 *
 * Default is a dry run. Sending requires --yes AND ORBIO_LIVE=true, and the
 * repo rule is that neither is set without written approval in the ticket.
 */
import {
  createPublicClient, createWalletClient, http, defineChain,
  parseAbi, formatUnits, getAddress, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const CHAIN_ID = 4663;
// Order matters. The official rpc.mainnet.chain.robinhood.com 429s after 2-3
// calls (verified 2026-09-19, see .env.example and docs/api-notes.md "S-03 chain
// reads") — it is deliberately NOT the default. This script makes 3 reads per
// quote, so the official RPC would rate-limit on a single run.
const DEFAULT_RPCS = [
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.ordofi.network',
];
const USDG_DECIMALS = 6;
const CREDIT_DECIMALS = 6;
const SLIPPAGE_BPS = 200n;          // minCreditOut = quote x 0.98
const DEFAULT_MAX_FILLS = 64n;      // Exchange.MAX_FILLS() reads 64

const exchangeAbi = parseAbi([
  'function feeBps() view returns (uint16)',
  'function MAX_FILLS() view returns (uint256)',
  'function getQuote(uint256 usdgIn, uint256 maxFills) view returns (uint256 creditOut, uint256 usdgSpent, uint256 feeAtoms, uint256 fills, uint8 reason)',
  'function buyAndActivate(uint256 usdgIn, uint256 minCreditOut, bytes32 beneficiary, uint256 maxFills) returns (uint256 creditOut, uint256 usdgSpent, uint256 activationId)',
]);
const creditAbi = parseAbi([
  'function activationFeeBps() view returns (uint16)',
  'function previewActivation(uint256 amount) view returns (uint256 credited, uint256 fee)',
]);
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const chain = defineChain({
  id: CHAIN_ID, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: (process.env.RH_RPC_URLS ?? DEFAULT_RPCS.join(','))
    .split(',').map((u) => u.trim()).filter(Boolean) } },
});

function die(msg: string): never { console.error(`orbio-buy: ${msg}`); process.exit(1); }

function addr(name: string): Address {
  const v = process.env[name];
  if (!v) die(`${name} is not set. Addresses are read from env, never hardcoded (CLAUDE.md #5).\n       See skills/orbio-buy/SKILL.md for the published values.`);
  try { return getAddress(v); } catch { return die(`${name} is not a valid address`); }
}

/** bytes32(uint256(uint160(address))) — the beneficiary encoding Orbio documents. */
function toBeneficiary(a: Address): Hex {
  return `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

interface Quote {
  creditOut: bigint; usdgSpent: bigint; feeAtoms: bigint; fills: bigint; reason: number;
  credited: bigint; activationFee: bigint;
  totalIn: bigint; grossDiscount: number; netDiscount: number;
}

async function readQuote(client: any, usdgIn: bigint, maxFills: bigint): Promise<Quote> {
  const exchange = addr('EXCHANGE_ADDRESS');
  const credit = addr('CREDIT_ADDRESS');
  const [creditOut, usdgSpent, feeAtoms, fills, reason] = await client.readContract({
    address: exchange, abi: exchangeAbi, functionName: 'getQuote', args: [usdgIn, maxFills],
  }) as [bigint, bigint, bigint, bigint, number];

  if (creditOut === 0n) die(`the book returned no credit for ${formatUnits(usdgIn, USDG_DECIMALS)} USDG (stop reason ${reason}). Nothing to buy right now.`);

  const [credited, activationFee] = await client.readContract({
    address: credit, abi: creditAbi, functionName: 'previewActivation', args: [creditOut],
  }) as [bigint, bigint];

  const totalIn = usdgSpent + feeAtoms;
  const grossDiscount = 1 - Number(totalIn) / Number(creditOut);
  const netDiscount = 1 - Number(totalIn) / Number(credited);
  return { creditOut, usdgSpent, feeAtoms, fills, reason, credited, activationFee, totalIn, grossDiscount, netDiscount };
}

function printQuote(q: Quote, feeBps: number, actFeeBps: number, usdgIn: bigint): void {
  const f = (v: bigint, d = USDG_DECIMALS) => formatUnits(v, d);
  console.log(`budget          : ${f(usdgIn)} USDG`);
  console.log(`book fee        : ${feeBps} bps (${(feeBps / 100).toFixed(2)}%)   taken out of usdgIn`);
  console.log(`activation fee  : ${actFeeBps} bps (${(actFeeBps / 100).toFixed(2)}%)   kept from the CREDIT bought`);
  console.log(`fills           : ${q.fills}   stop reason ${q.reason}`);
  console.log('');
  console.log(`spent           : ${f(q.totalIn)} USDG   (${f(q.usdgSpent)} to makers + ${f(q.feeAtoms)} book fee)`);
  console.log(`credit bought   : ${f(q.creditOut, CREDIT_DECIMALS)} CREDIT   gross ${pct(q.grossDiscount)}`);
  console.log(`activated       : ${f(q.credited, CREDIT_DECIMALS)} CREDIT   NET   ${pct(q.netDiscount)}   (fee ${f(q.activationFee, CREDIT_DECIMALS)})`);
  console.log('');
  console.log(`NET is the number to quote. Gross overstates by ${((q.grossDiscount - q.netDiscount) * 100).toFixed(2)} points.`);
}

function parseFlags(args: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`orbio-buy — buy CREDIT only when the NET discount clears a target

  orbio-buy quote <usdg>                          read-only: fees, quote, gross vs net
  orbio-buy plan <usdg> --min-discount <pct>      decide; prints the plan or a typed refusal
  orbio-buy buy <usdg> --min-discount <pct> --yes execute (also needs ORBIO_LIVE=true)

Flags: --max-fills <n> (default ${DEFAULT_MAX_FILLS})  --beneficiary <0x...>
       --write-proof <file>  append the tx to a proof fragment for orbio-cost

Env: EXCHANGE_ADDRESS, CREDIT_ADDRESS, USDG_ADDRESS, ORBIO_PRIVATE_KEY (buy only),
     RH_RPC_URLS (optional, comma separated), ORBIO_LIVE (must be "true" to send).
Addresses are never hardcoded. See SKILL.md.`);
    return;
  }

  const flags = parseFlags(rest);
  const usdgArg = rest.find((a) => !a.startsWith('--'));
  if (!usdgArg) die(`usage: orbio-buy ${cmd} <usdg> [flags]`);
  const usdgIn = BigInt(Math.round(Number(usdgArg) * 10 ** USDG_DECIMALS));
  if (usdgIn <= 0n) die('usdg must be positive');
  const maxFills = flags['max-fills'] ? BigInt(String(flags['max-fills'])) : DEFAULT_MAX_FILLS;

  const client = createPublicClient({ chain, transport: http() });
  const exchange = addr('EXCHANGE_ADDRESS');
  const credit = addr('CREDIT_ADDRESS');

  const feeBps = Number(await client.readContract({ address: exchange, abi: exchangeAbi, functionName: 'feeBps' }));
  const actFeeBps = Number(await client.readContract({ address: credit, abi: creditAbi, functionName: 'activationFeeBps' }));
  const q = await readQuote(client, usdgIn, maxFills);

  if (cmd === 'quote') { printQuote(q, feeBps, actFeeBps, usdgIn); return; }

  if (cmd !== 'plan' && cmd !== 'buy') die(`unknown command '${cmd}' (try: orbio-buy help)`);

  const target = flags['min-discount'] === undefined ? null : Number(flags['min-discount']) / 100;
  if (target === null) die('--min-discount <pct> is required. The point of this skill is refusing a bad fill.');

  printQuote(q, feeBps, actFeeBps, usdgIn);
  console.log('');
  console.log(`target          : ${pct(target)} net`);

  if (q.reason !== 0) {
    console.log(`\nREFUSED  reason=quote_stop_reason  the book stopped early (reason ${q.reason}).`);
    process.exit(2);
  }
  if (q.fills > maxFills) {
    console.log(`\nREFUSED  reason=fills_exceeded  ${q.fills} fills > max ${maxFills}.`);
    process.exit(2);
  }
  if (q.netDiscount < target) {
    console.log(`\nREFUSED  reason=discount_too_low  net ${pct(q.netDiscount)} < target ${pct(target)}. No transaction sent.`);
    process.exit(2);
  }

  const minCreditOut = (q.creditOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(`minCreditOut    : ${formatUnits(minCreditOut, CREDIT_DECIMALS)}  (quote - ${Number(SLIPPAGE_BPS) / 100}% slippage, truncated)`);
  console.log(`\nCLEARS TARGET  net ${pct(q.netDiscount)} >= ${pct(target)}`);

  const live = process.env.ORBIO_LIVE === 'true';
  const confirmed = flags['yes'] === true;
  if (cmd === 'plan' || !live || !confirmed) {
    console.log('\nDRY RUN — nothing sent.');
    if (cmd === 'buy') {
      if (!confirmed) console.log('  missing --yes');
      if (!live) console.log('  missing ORBIO_LIVE=true');
    }
    console.log('\nWould send 2 transactions:');
    console.log(`  1. USDG.approve(${exchange}, ${formatUnits(usdgIn, USDG_DECIMALS)})   exact amount, never infinite`);
    console.log(`  2. Exchange.buyAndActivate(${usdgIn}, ${minCreditOut}, <beneficiary>, ${maxFills})`);
    return;
  }

  // ---- live path -----------------------------------------------------------
  const pk = process.env.ORBIO_PRIVATE_KEY as Hex | undefined;
  if (!pk) die('ORBIO_PRIVATE_KEY is not set');
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain, transport: http() });
  const usdg = addr('USDG_ADDRESS');
  const beneficiary = toBeneficiary(
    flags['beneficiary'] ? getAddress(String(flags['beneficiary'])) : account.address,
  );

  const bal = await client.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as bigint;
  if (bal < usdgIn) die(`insufficient USDG: have ${formatUnits(bal, USDG_DECIMALS)}, need ${formatUnits(usdgIn, USDG_DECIMALS)}`);
  const gas = await client.getBalance({ address: account.address });
  if (gas === 0n) die('wallet has no ETH for gas');

  const allowance = await client.readContract({ address: usdg, abi: erc20Abi, functionName: 'allowance', args: [account.address, exchange] }) as bigint;
  if (allowance < usdgIn) {
    const { request } = await client.simulateContract({ account, address: usdg, abi: erc20Abi, functionName: 'approve', args: [exchange, usdgIn] });
    const h = await wallet.writeContract(request);
    console.log(`approve tx: ${h}`);
    const r = await client.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') die(`approve reverted (${h})`);
  }

  // simulate first: a revert is caught before gas is spent
  const { request } = await client.simulateContract({
    account, address: exchange, abi: exchangeAbi, functionName: 'buyAndActivate',
    args: [usdgIn, minCreditOut, beneficiary, maxFills],
  });
  const hash = await wallet.writeContract(request);
  console.log(`buyAndActivate tx: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });

  // Key names here are the schema `orbio-cost proof --chain` reads. Keep them in
  // step: a rename on either side silently drops a row from the artifact.
  const result = {
    status: receipt.status,
    explorer: 'https://robin.etherscan.io',
    buy_tx: hash,
    usdg_spent: formatUnits(q.totalIn, USDG_DECIMALS),
    bought_credit: formatUnits(q.creditOut, CREDIT_DECIMALS),
    activated_from_buy: formatUnits(q.credited, CREDIT_DECIMALS),
    net_discount: pct(q.netDiscount),
    gas_used: receipt.gasUsed.toString(),
  };
  console.log(JSON.stringify(result, null, 2));

  const proofPath = flags['write-proof'];
  if (typeof proofPath === 'string') {
    // Merge, never clobber: the stake rows (staked_orbio, claim_tx, activate_tx)
    // are written by the staking path and must survive a later buy.
    let merged: Record<string, unknown> = {};
    if (existsSync(proofPath)) {
      try { merged = JSON.parse(readFileSync(proofPath, 'utf8')); }
      catch { die(`${proofPath} exists but is not valid JSON — refusing to overwrite it`); }
    }
    writeFileSync(proofPath, JSON.stringify({ ...merged, ...result }, null, 2) + '\n');
    console.log(`\nproof fragment written: ${proofPath}`);
    console.log(`  render it: skills/orbio-cost/scripts/orbio-cost proof --chain ${proofPath}`);
  }

  if (receipt.status !== 'success') process.exit(1);
  console.log('\nNow confirm off-chain: skills/orbio-cost/scripts/orbio-cost balance');
}

main().catch((e) => die(String(e?.shortMessage ?? e?.message ?? e)));
