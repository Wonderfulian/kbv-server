/**
 * Queries the x402 Bazaar's natural-language search and reports where our
 * routes rank. The catalog reflects a paid settlement immediately, unlike the
 * bulk resource list, so this is the fast way to check discovery copy.
 *
 *   node scripts/bazaar-search.mjs "query one" "query two" ...
 */

const ENDPOINT = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';
const OURS = /kbv-server/;

const queries = process.argv.slice(2);
if (!queries.length) {
  console.error('usage: node scripts/bazaar-search.mjs "query" ["query" ...]');
  process.exit(1);
}

for (const q of queries) {
  const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(q)}`);
  const body = await res.json();
  const all = body.resources ?? [];
  const mine = all.filter((r) => OURS.test(r.resource ?? ''));
  console.log(`\n"${q}" — ${all.length} results, ours: ${mine.length}`);
  for (const r of mine) {
    const rank = all.indexOf(r) + 1;
    const path = (r.resource ?? '').replace('https://kbv-server-f7vfitmlkq-du.a.run.app', '');
    console.log(`   #${rank}  ${path}  [${r.accepts?.[0]?.scheme} ${r.accepts?.[0]?.amount}]`);
  }
}
