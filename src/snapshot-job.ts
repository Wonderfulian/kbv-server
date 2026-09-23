/**
 * Entry point for the daily snapshot, run as a Cloud Run Job on a Cloud
 * Scheduler trigger. It shares the server's container image — the job simply
 * starts `dist/snapshot-job.js` instead of `dist/index.js`, so there is no
 * second build, no second deploy pipeline, and no extra idle cost.
 *
 *   SNAPSHOT_BUCKET   GCS bucket for corpus/status/changes (production)
 *   SNAPSHOT_DIR      local directory instead of GCS (dry runs)
 *   SNAPSHOT_CONCURRENCY  parallel NTS batches (default 4)
 *
 * Note: the job talks to the NTS client directly rather than through
 * service.ts. Going through the service layer would emit `tool_call` events
 * and pollute the usage metrics we judge real demand by (MONITORING.md), and
 * would waste the request cache on numbers no user asked for.
 */

import dotenv from 'dotenv';
import { createNtsClient } from './nts.js';
import { runSnapshot } from './snapshot.js';
import { GcsSnapshotStore, LocalSnapshotStore } from './snapshot-store.js';

dotenv.config({ quiet: true });

const serviceKey = process.env.NTS_SERVICE_KEY;
if (!serviceKey) {
  console.error('FATAL: NTS_SERVICE_KEY is not set.');
  process.exit(1);
}

const bucket = process.env.SNAPSHOT_BUCKET;
const dir = process.env.SNAPSHOT_DIR;
if (!bucket && !dir) {
  console.error('FATAL: set SNAPSHOT_BUCKET (production) or SNAPSHOT_DIR (dry run).');
  process.exit(1);
}

const store = bucket ? new GcsSnapshotStore(bucket) : new LocalSnapshotStore(dir as string);

try {
  const summary = await runSnapshot({
    nts: createNtsClient({ serviceKey }),
    store,
    concurrency: Number(process.env.SNAPSHOT_CONCURRENCY ?? 4),
    log: (info) => console.log(JSON.stringify(info)),
  });
  // A run that observed nothing is a failure worth alerting on: either the
  // corpus is empty or every batch failed.
  if (summary.observed === 0 && summary.corpus_size > 0) {
    console.error(JSON.stringify({ event: 'snapshot_empty', ...summary }));
    process.exit(1);
  }
} catch (err) {
  console.error(JSON.stringify({ event: 'snapshot_failed', error: (err as Error).message }));
  process.exit(1);
}
