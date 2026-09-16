/**
 * Pay once for each paid route on Base mainnet so the CDP facilitator indexes
 * it in the x402 Bazaar (the catalog only lists routes with a real settlement).
 *
 * Run when a paid route is added or its declaration changes:
 *   node scripts/x402-index-routes.mjs            # verify + batch
 *   node scripts/x402-index-routes.mjs status     # only the named routes
 *
 * Spends REAL USDC (~$0.09 for verify + batch) from the throwaway payer in the
 * gitignored .env.test-payer. Since the free tier is opt-in (?free=1), plain
 * requests already answer 402 — no free-tier burn needed.
 */

import { readFileSync } from 'node:fs';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { base } from 'viem/chains';

const BASE = process.env.KBV_BASE_URL ?? 'https://kbv-server-f7vfitmlkq-du.a.run.app';
const RPC_URL = 'https://mainnet.base.org';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet USDC
const RECEIVER = '0xbD23a7e6eE1F1b8b5D5AeFEB4fBdE2B84C04bD5C';

const ROUTES = {
  status: {
    label: 'status (exact $0.02)',
    url: `${BASE}/v1/business/124-81-00998/status`,
    init: { method: 'GET' },
  },
  verify: {
    label: 'verify (exact $0.05)',
    url: `${BASE}/v1/business/verify`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_number: '124-81-00998',
        representative_name: '홍길동',
        opening_date: '2015-03-02',
      }),
    },
  },
  batch: {
    label: 'batch (upto $2.00 ceiling, settles 2 x $0.02)',
    url: `${BASE}/v1/business/batch`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_numbers: ['124-81-00998', '220-81-62517'] }),
    },
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['verify', 'batch'];
for (const name of wanted) if (!ROUTES[name]) throw new Error(`unknown route: ${name}`);

const pk = /TEST_PAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/.exec(
  readFileSync(new URL('../.env.test-payer', import.meta.url), 'utf8'),
)?.[1];
if (!pk) throw new Error('TEST_PAYER_PRIVATE_KEY not found in .env.test-payer');
const signer = privateKeyToAccount(pk);

const pub = createPublicClient({ chain: base, transport: http(RPC_URL) });
/**
 * Balance read with retries — a public-RPC hiccup here once looked like a
 * failed run and triggered a duplicate payment. Never let a balance read
 * decide whether the payments happened.
 */
async function bal(addr) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

console.log('network: Base mainnet (REAL USDC) | routes:', wanted.join(', '));
console.log('payer:', signer.address);
const payerBefore = await bal(signer.address);
const recvBefore = await bal(RECEIVER);
console.log('before | payer:', formatUnits(payerBefore, 6), '| receiver:', formatUnits(recvBefore, 6));
if (payerBefore === 0n) throw new Error('payer holds no USDC on Base mainnet');

// rpcUrl enables the gas-sponsored Permit2 allowance signing the upto scheme
// needs (without it the server answers 412 permit2_allowance_required).
const rpcOptions = { rpcUrl: RPC_URL };
const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(signer, rpcOptions));
client.register('eip155:*', new UptoEvmScheme(signer, rpcOptions));
client.setSpendControls({ maxAmountPerPayment: '$2' }); // batch authorizes a $2.00 ceiling
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const results = [];
for (const name of wanted) {
  const route = ROUTES[name];
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const res = await fetchWithPayment(route.url, route.init);
    const body = await res.text();
    console.log(`\n${route.label} (attempt ${attempt}): HTTP ${res.status}`);
    console.log('  body:', body.slice(0, 180));
    try {
      const settle = httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
      console.log('  settle:', JSON.stringify(settle));
    } catch {
      console.log('  settle: no payment response header');
    }
    const ext = res.headers.get('extension-responses');
    if (ext) console.log('  extension-responses:', ext);
    ok = res.status === 200;
    if (!ok) await new Promise((r) => setTimeout(r, 5000));
  }
  results.push(`${name}: ${ok ? 'PAID' : 'FAILED'}`);
}

console.log('\nRESULT |', results.join(' | '));
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const now = await bal(RECEIVER);
  if (now > recvBefore) {
    console.log(`receiver USDC: ${formatUnits(now, 6)} (+${formatUnits(now - recvBefore, 6)})`);
    break;
  }
  if (i === 9) console.log('receiver balance unchanged after 30s — check settle output above');
}
try {
  console.log('payer USDC after:', formatUnits(await bal(signer.address), 6));
} catch {
  console.log('payer balance read failed (RPC) — payments above already settled; do NOT re-run blindly');
}
