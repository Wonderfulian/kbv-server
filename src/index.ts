/**
 * Boot only: env loading, process-wide singleton deps, listen.
 * App wiring lives in app.ts so tests can inject mock deps.
 */

import { createFacilitatorConfig } from '@coinbase/x402';
import { HTTPFacilitatorClient } from '@x402/core/server';
import dotenv from 'dotenv';
import { buildApp, type X402Options } from './app.js';
import { createCache } from './cache.js';
import { createDartClient } from './dart.js';
import { createCustomsClient, CUSTOMS_PROBE_URL } from './customs.js';
import { createEgressGuard, probeHost } from './egress-guard.js';
import type { Server } from 'node:http';
import { CONDITIONS_PATH, ConditionsIndex, NOTICE_WATCH_PATH, WATCH_STALE_DAYS, type ConditionsFile, type NoticeWatchFile } from './hs-conditions.js';
import { HS_MASTER_PATH, HsMaster, type HsMasterFile } from './hs-master.js';
import type { TradeDeps } from './import-requirements.js';
import { ITEM_NAMES_PATH, TARIFF_PATH, TariffIndex, type ItemNamesFile, type TariffFile } from './tariff.js';
import { GcsNameIndexStore } from './name-index-store.js';
import { createNtsClient, NTS_PROBE_URL } from './nts.js';
import { createSanctionsLookup, type SanctionsFile } from './sanctions.js';
import { memoizeIndex, searchBusinesses } from './search.js';
import type { Deps } from './service.js';

dotenv.config({ quiet: true });

const serviceKey = process.env.NTS_SERVICE_KEY;
if (!serviceKey) {
  // Fail fast with a clear hint; never print key material.
  console.error('FATAL: NTS_SERVICE_KEY is not set. Copy .env.example to .env and add your data.go.kr decoding key.');
  process.exit(1);
}

const nts = createNtsClient({
  serviceKey,
  onLatency: (endpoint, ms, ok) => console.log(JSON.stringify({ event: 'nts_call', endpoint, ms, ok })),
});

/**
 * Name search is enabled only where an index bucket is configured. The index
 * is read once, lazily, on the first search: it is tens of megabytes, and a
 * deployment that never searches should not pay for it at boot. DART resolves
 * the business numbers the index has not filled in yet, one candidate at a
 * time, memoized for the life of the process.
 */
const indexBucket = process.env.NAME_INDEX_BUCKET;
const dartKey = process.env.DART_API_KEY;
const search = indexBucket
  ? (() => {
      const store = new GcsNameIndexStore(indexBucket);
      const loadIndex = memoizeIndex(async () => {
        const started = Date.now();
        const entries = await store.read();
        console.log(JSON.stringify({ event: 'name_index_loaded', entries: entries.length, ms: Date.now() - started }));
        return entries;
      });
      const resolved = new Map<string, string>();
      const dart = dartKey ? createDartClient({ apiKey: dartKey }) : undefined;
      return (query: string, opts: { full: boolean; limit?: number }) =>
        searchBusinesses({ loadIndex, nts, dart, resolved }, query, opts);
    })()
  : undefined;

/**
 * Debarment screening for the batch endpoint, from the same bucket. Loaded
 * lazily on first use: it is a few hundred rows, but a deployment that only
 * serves single lookups should not read it at all.
 */
const sanctions = indexBucket
  ? createSanctionsLookup(async () => {
      const started = Date.now();
      const file = await new GcsNameIndexStore(indexBucket).readJson<SanctionsFile>('sanctions/current.json');
      console.log(
        JSON.stringify({ event: 'sanctions_loaded', records: file?.sanctions.length ?? 0, ms: Date.now() - started }),
      );
      return file;
    })
  : undefined;

/**
 * A bucket file loaded on first use and kept for the life of the process. A
 * failed load is not cached, so the next request retries instead of the route
 * staying down until a restart.
 */
/**
 * Loads an index from the bucket on first use. With `maxAgeMs`, a request
 * after that age starts a reload in the background and keeps answering from
 * the copy it has until the new one is ready — for files a job rewrites in
 * place (the condition index, rebuilt when the notice is amended), which a
 * long-lived instance would otherwise never see.
 */
function lazyFromBucket<F, T>(
  bucket: string,
  path: string,
  name: string,
  build: (file: F) => T,
  describe: (file: F) => Record<string, unknown>,
  maxAgeMs?: number,
) {
  let loading: Promise<T> | undefined;
  let loadedAt = 0;
  let refreshing = false;
  const load = async () => {
    const started = Date.now();
    const file = await new GcsNameIndexStore(bucket).readJson<F>(path);
    if (!file) throw new Error(`${path} is missing from the index bucket`);
    const out = build(file);
    loadedAt = Date.now();
    console.log(JSON.stringify({ event: `${name}_loaded`, ...describe(file), ms: Date.now() - started }));
    return out;
  };
  return () => {
    if (loading && maxAgeMs && !refreshing && loadedAt && Date.now() - loadedAt > maxAgeMs) {
      refreshing = true;
      load()
        .then((fresh) => {
          loading = Promise.resolve(fresh);
        })
        .catch((err: unknown) => {
          loadedAt = Date.now(); // keep the old copy; try again after another interval
          console.error(JSON.stringify({ event: `${name}_reload_failed`, error: (err as Error).message }));
        })
        .finally(() => {
          refreshing = false;
        });
    }
    loading ??= load().catch((err: unknown) => {
      loading = undefined;
      console.error(JSON.stringify({ event: `${name}_load_failed`, error: (err as Error).message }));
      throw err;
    });
    return loading;
  };
}

/** hs/notice-watch.json, re-read hourly; null when no watch has succeeded yet. */
function noticeWatchLoader(bucket: string) {
  let cached: { at: number; value: Promise<NoticeWatchFile | null> } | undefined;
  return () => {
    if (!cached || Date.now() - cached.at > 60 * 60 * 1000) {
      const value = new GcsNameIndexStore(bucket).readJson<NoticeWatchFile>(NOTICE_WATCH_PATH);
      cached = { at: Date.now(), value };
      value.catch(() => (cached = undefined));
    }
    return cached.value;
  };
}

function throttleHourly<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let last = 0;
  return (...args) => {
    if (Date.now() - last < 60 * 60 * 1000) return;
    last = Date.now();
    fn(...args);
  };
}

// Everything below is mounted only with the stage flag: until the route ships,
// its path must not answer at all — HS codes in its URL reach the access log,
// and the privacy notes say so only together with the route.
const tradeDeskEnabled = process.env.TRADE_DESK_ENABLED === '1';
const tradeBucket = indexBucket && tradeDeskEnabled ? indexBucket : undefined;

/** HS code master for validation (≈1.7 MB). */
const hsMaster = tradeBucket
  ? lazyFromBucket<HsMasterFile, HsMaster>(tradeBucket, HS_MASTER_PATH, 'hs_master', (f) => new HsMaster(f), (f) => ({
      file_name: f.file_name,
    }))
  : undefined;

/**
 * Self-healing for a lost route to the customs host (see egress-guard.ts):
 * 3 consecutive network failures (each already 3 attempts) → probe both
 * hosts; exit only when customs is unreachable and NTS is reachable, after
 * 10 minutes of uptime, at most once per 30 minutes across the fleet.
 */
const SELF_EXIT_MARKER = 'ops/self-exit.json';
const SELF_EXIT_INTERVAL_MS = 30 * 60 * 1000;
const egressGuard = tradeBucket
  ? createEgressGuard({
      threshold: 3,
      minUptimeMs: 10 * 60 * 1000,
      probeCustoms: () => probeHost(CUSTOMS_PROBE_URL),
      probeNts: () => probeHost(NTS_PROBE_URL),
      claimExit: async () => {
        const store = new GcsNameIndexStore(tradeBucket);
        const last = await store.readJson<{ at: string }>(SELF_EXIT_MARKER);
        if (last && Date.now() - Date.parse(last.at) < SELF_EXIT_INTERVAL_MS) return false;
        await store.writeJson(SELF_EXIT_MARKER, { at: new Date().toISOString(), reason: 'customs host unreachable, NTS reachable' });
        return true;
      },
      uptimeMs: () => process.uptime() * 1000,
      log: (info) => console.log(JSON.stringify(info)),
      terminate: () => {
        // Stop taking requests, let in-flight ones finish, then exit; Cloud Run replaces the instance.
        server?.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 10_000).unref();
      },
    })
  : undefined;

const trade: TradeDeps | undefined = tradeBucket
  ? {
      customs: createCustomsClient({
        serviceKey,
        onLatency: (ms, ok, failure) => {
          console.log(JSON.stringify({ event: 'customs_call', ms, ok, ...(failure ? { failure } : {}) }));
          egressGuard?.record(ok, failure);
        },
      }),
      // Re-read every 6 h: kbv-lawgo's daily watch rewrites it when the notice is amended.
      conditions: lazyFromBucket<ConditionsFile, ConditionsIndex>(
        tradeBucket,
        CONDITIONS_PATH,
        'conditions',
        (f) => new ConditionsIndex(f),
        (f) => ({ notice_no: f.notice.notice_no, effective_from: f.notice.effective_from, statute_groups: Boolean(f.statute_groups) }),
        6 * 60 * 60 * 1000,
      ),
      tariff: lazyFromBucket<TariffFile, TariffIndex>(tradeBucket, TARIFF_PATH, 'tariff', (f) => new TariffIndex(f), (f) => ({
        file_name: f.file_name,
      })),
      itemNames: lazyFromBucket<ItemNamesFile, ItemNamesFile>(tradeBucket, ITEM_NAMES_PATH, 'item_names', (f) => f, (f) => ({
        file_name: f.file_name,
      })),
      // Dictionary health: a rising count of misses means codes or names arrived
      // that the dictionary does not know; review_due means the notice was revised.
      onDictMiss: (m) => console.log(JSON.stringify({ event: 'dict_miss', ...m })),
      onReviewDue: (aply) => console.log(JSON.stringify({ event: 'dict_review_due', aply_strt_dt: aply })),
      noticeWatch: noticeWatchLoader(tradeBucket),
      // Severity WARNING so it stands out in the log viewer; at most once an hour per instance.
      onWatchStale: throttleHourly((days) =>
        console.warn(JSON.stringify({ severity: 'WARNING', event: 'notice_watch_stale', days_since_check: days, threshold_days: WATCH_STALE_DAYS })),
      ),
    }
  : undefined;

// Process-wide singletons: the cache must outlive per-request MCP servers.
const deps: Deps = {
  cache: createCache(),
  nts,
  // Metrics only — no business numbers or names ever reach the logs.
  log: (info) => console.log(JSON.stringify({ event: 'tool_call', ...info })),
  ...(search ? { search } : {}),
  ...(sanctions ? { sanctions } : {}),
  ...(hsMaster
    ? { hsMaster, hsLog: (info: Record<string, unknown>) => console.log(JSON.stringify({ event: 'hs_check', ...info })) }
    : {}),
  ...(trade ? { trade } : {}),
};
console.log(JSON.stringify({ event: 'search_config', enabled: Boolean(search), dart_enrichment: Boolean(dartKey), sanctions: Boolean(sanctions) }));

// Payments are OFF unless a receiving address is configured (address only —
// private keys and seed phrases never touch this server).
const payTo = process.env.X402_PAY_TO_ADDRESS;
// CDP keys present -> authenticated Coinbase facilitator (mainnet path); the
// keys are mounted from Secret Manager and are read here only, never logged.
const cdpFacilitator =
  process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET ? createFacilitatorConfig() : undefined;
const x402: X402Options | undefined = payTo
  ? {
      payTo,
      facilitatorUrl: cdpFacilitator?.url ?? process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
      network: process.env.X402_NETWORK ?? 'eip155:84532', // Base Sepolia testnet
      dailyFreeTier: Number(process.env.FREE_TIER_DAILY ?? 10),
      facilitatorClient: cdpFacilitator ? new HTTPFacilitatorClient(cdpFacilitator) : undefined,
      // Off until the import-requirements handler exists (TRADE-DESK stage 4).
      tradeDesk: tradeDeskEnabled,
    }
  : undefined;
console.log(
  JSON.stringify({
    event: 'x402_config',
    enabled: Boolean(x402),
    network: x402?.network ?? null,
    facilitator: x402 ? (cdpFacilitator ? 'cdp' : x402.facilitatorUrl) : null,
  }),
);

export const app = buildApp(deps, x402);
let server: Server | undefined;

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 8080);
  server = app.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', port }));
  });
}
