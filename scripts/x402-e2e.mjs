/**
 * x402 E2E (PHASE2 stage 2 verification):
 *   1. burn the free tier until the live server answers 402
 *   2. pay for GET /v1/business/{brno}/status  (exact scheme, $0.02)
 *   3. pay for POST /v1/business/batch of 2    (upto scheme: authorize $2.00, settle $0.04)
 *   4. watch the receiving address's USDC balance rise on-chain
 *
 * Default network is Base Sepolia (testnet). KBV_NETWORK=mainnet switches to
 * Base mainnet with REAL USDC — there it runs the exact payment only, unless
 * KBV_E2E_UPTO=1 also opts into the batch payment (extra $0.04 real spend).
 *
 * Reads the THROWAWAY payer key from the gitignored .env.test-payer.
 * No secrets in this file; safe to commit.
 */

import { readFileSync } from 'node:fs';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { base, baseSepolia } from 'viem/chains';

const MAINNET = process.env.KBV_NETWORK === 'mainnet';
const RUN_UPTO = !MAINNET || process.env.KBV_E2E_UPTO === '1';
const CHAIN = MAINNET ? base : baseSepolia;
const RPC_URL = MAINNET ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
const USDC = MAINNET
  ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // official Base mainnet USDC
  : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // official Base Sepolia USDC
const BASE = process.env.KBV_BASE_URL ?? 'https://kbv-server-f7vfitmlkq-du.a.run.app';
const RECEIVER = '0xbD23a7e6eE1F1b8b5D5AeFEB4fBdE2B84C04bD5C';
console.log('network:', MAINNET ? 'Base mainnet (REAL USDC)' : 'Base Sepolia (testnet)');

const envText = readFileSync(new URL('../.env.test-payer', import.meta.url), 'utf8');
const pk = /TEST_PAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/.exec(envText)?.[1];
if (!pk) throw new Error('TEST_PAYER_PRIVATE_KEY not found in .env.test-payer');
const signer = privateKeyToAccount(pk);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
const bal = (addr) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });

console.log('payer:', signer.address);
const payerBefore = await bal(signer.address);
const recvBefore = await bal(RECEIVER);
console.log('before | payer USDC:', formatUnits(payerBefore, 6), '| receiver USDC:', formatUnits(recvBefore, 6));
if (payerBefore === 0n)
  throw new Error(MAINNET ? 'payer holds no USDC on Base mainnet — fund it first' : 'payer holds no test USDC — run the faucet step first');

// 1) burn today's free tier so the paid path is actually exercised
const statusUrl = `${BASE}/v1/business/124-81-00998/status`;
let last;
for (let i = 0; i < 12; i++) {
  last = await fetch(statusUrl);
  if (last.status === 402) break;
}
console.log('free-tier burn: reached HTTP', last.status);
if (last.status !== 402) throw new Error('never hit 402 — payment path not reachable');

// 2) exact: pay $0.02 for a single status lookup
// rpcUrl enables on-chain reads + gas-sponsored Permit2 allowance signing,
// which the upto scheme requires (without it the server answers 412
// permit2_allowance_required).
const rpcOptions = { rpcUrl: RPC_URL };
const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(signer, rpcOptions));
client.register('eip155:*', new UptoEvmScheme(signer, rpcOptions));
// The upto batch authorizes a $2.00 ceiling — above the client SDK's default
// $1-per-payment guard, so raise it for this test.
client.setSpendControls({ maxAmountPerPayment: '$2' });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

function printSettle(label, res) {
  try {
    console.log(`settle (${label}):`, JSON.stringify(httpClient.getPaymentSettleResponse((n) => res.headers.get(n))));
  } catch {
    console.log(`settle (${label}): no payment response header`);
  }
}

/** Paid call with retries — the free testnet facilitator's relayer flakes occasionally. */
async function paidCall(label, url, init) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithPayment(url, init);
    const body = await res.json().catch(() => null);
    console.log(`${label} (attempt ${attempt}): HTTP ${res.status} |`, JSON.stringify(body)?.slice(0, 200));
    printSettle(label, res);
    if (res.status === 200) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

const okExact = await paidCall('exact status', statusUrl, { method: 'GET' });

// 3) upto: authorize $2.00 ceiling, settle 2 x $0.02 = $0.04
let okUpto = null;
if (RUN_UPTO) {
  okUpto = await paidCall('upto batch', `${BASE}/v1/business/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business_numbers: ['124-81-00998', '1234567890'] }),
  });
}
console.log(
  'RESULT | exact:',
  okExact ? 'PAID' : 'FAILED',
  '| upto:',
  okUpto === null ? 'SKIPPED (mainnet default)' : okUpto ? 'PAID' : 'FAILED',
);

// 4) confirm on-chain arrival ($0.02 + $0.04 = $0.06 expected)
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const recvNow = await bal(RECEIVER);
  if (recvNow > recvBefore) {
    console.log(`receiver USDC now: ${formatUnits(recvNow, 6)} (+${formatUnits(recvNow - recvBefore, 6)})`);
    break;
  }
  if (i === 9) console.log('receiver balance unchanged after 30s — check settle responses above');
}
console.log('after | payer USDC:', formatUnits(await bal(signer.address), 6));
