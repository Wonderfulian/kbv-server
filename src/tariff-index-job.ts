/**
 * Builds the tariff schedule and HS item-name indexes (tariff.ts) from their
 * data.go.kr files and stores them next to the HS master in the index bucket.
 * Annual, like the HS master; the tariff schedule's next edition is due
 * 2027-01-31, a month after the current one runs out — the index keeps
 * serving the old edition (flagged stale) until then.
 *
 * TARIFF_FILE / ITEM_NAMES_FILE=<path.xlsx> skip the download (manual fallback).
 */

import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { downloadDataGoKrFile, type Download } from './hs-master-job.js';
import { isMainModule } from './is-main.js';
import { GcsNameIndexStore, LocalNameIndexStore, type NameIndexStore } from './name-index-store.js';
import { buildItemNamesFile, buildTariffFile, ITEM_NAMES_PATH, TARIFF_PATH } from './tariff.js';
import { readFirstSheet, readSheets } from './xlsx.js';

export const TARIFF_DATASET = '15051179';
export const ITEM_NAMES_DATASET = '15130660';

export async function buildTariffIndexes(opts: {
  store: NameIndexStore;
  downloadTariff: () => Promise<Download>;
  downloadItemNames: () => Promise<Download>;
  log: (info: Record<string, unknown>) => void;
  now?: () => Date;
}): Promise<void> {
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();

  const t = await opts.downloadTariff();
  const tariff = buildTariffFile(readFirstSheet(t.body), {
    source: 'Korea Customs Service, tariff schedule by HS code (관세청_품목번호별 관세율표), data.go.kr 15051179, KOGL Type 1',
    dataset: TARIFF_DATASET,
    file_name: t.fileName,
    fetched_at: fetchedAt,
  });
  await opts.store.writeJson(TARIFF_PATH, tariff, { compact: true });
  let rows = 0;
  let atEditionEnd = 0;
  const endIdx = tariff.dates.indexOf(tariff.edition_end);
  for (const list of Object.values(tariff.rates)) {
    rows += list.length;
    for (const r of list) if (r[7] === endIdx) atEditionEnd++;
  }
  opts.log({
    event: 'tariff_index_built',
    file_name: t.fileName,
    codes: Object.keys(tariff.rates).length,
    rows,
    edition_end: tariff.edition_end,
    rows_ending_at_edition_end: atEditionEnd,
    rows_with_own_end_date: rows - atEditionEnd,
  });

  const n = await opts.downloadItemNames();
  const names = buildItemNamesFile(readSheets(n.body), {
    source: 'Korea Customs Service, HS item names by level (관세청_HS부호 단위별 품목명), data.go.kr 15130660, KOGL Type 1',
    dataset: ITEM_NAMES_DATASET,
    file_name: n.fileName,
    fetched_at: fetchedAt,
  });
  await opts.store.writeJson(ITEM_NAMES_PATH, names, { compact: true });
  const levels: Record<number, number> = {};
  for (const c of Object.keys(names.names)) levels[c.length] = (levels[c.length] ?? 0) + 1;
  opts.log({ event: 'item_names_built', file_name: n.fileName, levels });
}

// --- entry point -----------------------------------------------------------

if (process.env.VITEST === undefined && isMainModule(import.meta.url)) {
  dotenv.config({ quiet: true });
  const bucket = process.env.NAME_INDEX_BUCKET;
  const dir = process.env.NAME_INDEX_DIR;
  if (!bucket && !dir) {
    console.error('FATAL: set NAME_INDEX_BUCKET (production) or NAME_INDEX_DIR (dry run).');
    process.exit(1);
  }
  const local = (path: string | undefined, dataset: string) =>
    path ? async () => ({ fileName: path, body: await readFile(path) }) : () => downloadDataGoKrFile(dataset);
  try {
    await buildTariffIndexes({
      store: bucket ? new GcsNameIndexStore(bucket) : new LocalNameIndexStore(dir as string),
      downloadTariff: local(process.env.TARIFF_FILE, TARIFF_DATASET),
      downloadItemNames: local(process.env.ITEM_NAMES_FILE, ITEM_NAMES_DATASET),
      log: (info) => console.log(JSON.stringify(info)),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'tariff_index_failed', error: (err as Error).message }));
    process.exit(1);
  }
}
