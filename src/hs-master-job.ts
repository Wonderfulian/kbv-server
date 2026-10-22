/**
 * Builds the HS code master (hs-master.ts) from the Korea Customs Service
 * "HS부호" file on data.go.kr (dataset 15049722) and stores it at
 * hs/hs-master.json in the name index bucket.
 *
 * The source is published once a year as an XLSX download, not an API, so
 * this follows the portal's own download flow: the dataset page names the
 * file, selectFileDataDownload resolves its attachment id, fileDownload
 * serves it. Any step that changes shape fails the run loudly — an annual
 * job that silently keeps last year's codes would reject this year's goods.
 *
 * HS_MASTER_FILE=<path.xlsx> skips the download (manual fallback).
 * License: 공공누리 제1유형 (attribution) — the source is recorded in the file.
 */

import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { buildHsMasterFile, HS_MASTER_PATH, HsMasterError, type HsMasterFile } from './hs-master.js';
import { isMainModule } from './is-main.js';
import { GcsNameIndexStore, LocalNameIndexStore, type NameIndexStore } from './name-index-store.js';
import { readFirstSheet } from './xlsx.js';

const PORTAL = 'https://www.data.go.kr';
export const HS_DATASET = '15049722';
const SOURCE = 'Korea Customs Service, HS code table (관세청_HS부호), data.go.kr dataset 15049722, KOGL Type 1';

export interface Download {
  fileName: string;
  body: Buffer;
}

/**
 * The portal's "차기 등록 예정일" (next scheduled registration) for a file
 * dataset, or null when the page states none. Read from the dataset page.
 */
export async function nextEditionDue(dataset: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const page = await (await fetchFn(`${PORTAL}/data/${dataset}/fileData.do`)).text();
  const text = page.replace(/<[^>]+>/g, ' ');
  const at = text.indexOf('차기 등록 예정일');
  if (at < 0) return null;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text.slice(at, at + 200));
  return m ? m[1] : null;
}

export function downloadHsFile(fetchFn: typeof fetch = fetch): Promise<Download> {
  return downloadDataGoKrFile(HS_DATASET, fetchFn);
}

/**
 * Any data.go.kr file dataset, through the portal's own download flow. Every
 * annual KCS table (HS master, tariff schedule, item names) comes this way.
 */
export async function downloadDataGoKrFile(dataset: string, fetchFn: typeof fetch = fetch): Promise<Download> {
  const page = await (await fetchFn(`${PORTAL}/data/${dataset}/fileData.do`)).text();
  const detail = new RegExp(`fn_fileDataDown\\('${dataset}',\\s*'(uddi:[0-9a-f-]+)'`).exec(page)?.[1];
  if (!detail) throw new HsMasterError(`data.go.kr dataset ${dataset} page no longer names its file (download flow changed)`);

  const meta = await fetchFn(`${PORTAL}/tcs/dss/selectFileDataDownload.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      publicDataPk: dataset,
      publicDataDetailPk: detail,
      atchFileId: '',
      fileDetailSn: '1',
      publicDataHistSn: '1',
    }),
  });
  const info = (await meta.json()) as {
    atchFileId?: string;
    fileDetailSn?: string | number;
    dataSetFileDetailInfo?: { dataNm?: string };
  };
  if (!info.atchFileId) throw new HsMasterError(`data.go.kr did not resolve the attachment id for dataset ${dataset}`);

  const file = await fetchFn(
    `${PORTAL}/cmm/cmm/fileDownload.do?atchFileId=${encodeURIComponent(info.atchFileId)}&fileDetailSn=${encodeURIComponent(String(info.fileDetailSn ?? 1))}`,
  );
  if (!file.ok) throw new HsMasterError(`dataset ${dataset} download failed: HTTP ${file.status}`);
  const body = Buffer.from(await file.arrayBuffer());
  if (body.subarray(0, 2).toString('latin1') !== 'PK') throw new HsMasterError(`dataset ${dataset} download is not an XLSX`);
  return { fileName: info.dataSetFileDetailInfo?.dataNm ?? 'unknown', body };
}

export async function buildHsMaster(opts: {
  store: NameIndexStore;
  download: () => Promise<Download>;
  log: (info: Record<string, unknown>) => void;
  now?: () => Date;
}): Promise<HsMasterFile> {
  const { fileName, body } = await opts.download();
  const file = buildHsMasterFile(readFirstSheet(body), {
    source: SOURCE,
    dataset: HS_DATASET,
    file_name: fileName,
    fetched_at: (opts.now?.() ?? new Date()).toISOString(),
  });
  await opts.store.writeJson(HS_MASTER_PATH, file);
  const codes = Object.keys(file.codes);
  opts.log({
    event: 'hs_master_built',
    file_name: fileName,
    ten_digit: codes.filter((c) => c.length === 10).length,
    groupings: codes.filter((c) => c.length < 10).length,
  });
  return file;
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
  const localFile = process.env.HS_MASTER_FILE;
  try {
    await buildHsMaster({
      store: bucket ? new GcsNameIndexStore(bucket) : new LocalNameIndexStore(dir as string),
      download: localFile
        ? async () => ({ fileName: localFile, body: await readFile(localFile) })
        : () => downloadHsFile(),
      log: (info) => console.log(JSON.stringify(info)),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'hs_master_build_failed', error: (err as Error).message }));
    process.exit(1);
  }
}
