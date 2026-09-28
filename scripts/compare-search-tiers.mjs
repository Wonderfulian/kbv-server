/**
 * Prints the free and the paid answer to the same name search, side by side.
 *
 * The tiering claim — "finding is free, confirming is paid" — is only worth
 * making if the two responses actually differ, so this pays for one real call
 * ($0.02 on Base mainnet from the throwaway payer in .env.test-payer) and
 * diffs the candidate fields rather than taking the code's word for it.
 *
 *   node scripts/compare-search-tiers.mjs ["company name"]
 */

import { readFileSync } from 'node:fs';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.KBV_BASE_URL ?? 'https://kbv-server-f7vfitmlkq-du.a.run.app';
const query = process.argv[2] ?? 'Samsung Electronics';
const url = `${BASE}/v1/business/search?q=${encodeURIComponent(query)}`;

const pk = /TEST_PAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/.exec(
  readFileSync(new URL('../.env.test-payer', import.meta.url), 'utf8'),
)?.[1];
if (!pk) throw new Error('TEST_PAYER_PRIVATE_KEY not found in .env.test-payer');

const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(privateKeyToAccount(pk), { rpcUrl: 'https://mainnet.base.org' }));
const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`query: ${query}\n`);

const freeRes = await fetch(`${url}&free=1`);
const free = await freeRes.json();
console.log(`===== FREE (?free=1) — HTTP ${freeRes.status} =====`);
console.log(JSON.stringify(free, null, 1));

const paidRes = await paidFetch(url);
const paid = await paidRes.json();
console.log(`\n===== PAID ($0.02) — HTTP ${paidRes.status} =====`);
console.log(JSON.stringify(paid, null, 1));

const freeKeys = Object.keys(free.candidates?.[0] ?? {});
const paidKeys = Object.keys(paid.candidates?.[0] ?? {});
console.log('\n===== difference =====');
console.log('free candidate fields:', freeKeys.join(', ') || '(none)');
console.log('paid candidate fields:', paidKeys.join(', ') || '(none)');
console.log('paid only:', paidKeys.filter((k) => !freeKeys.includes(k)).join(', ') || '(none)');
console.log('top-level `source`: free =', Boolean(free.source), '| paid =', Boolean(paid.source));
