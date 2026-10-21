/**
 * law.go.kr connectivity check and fetcher, run as a Cloud Run Job so the OC
 * secret is read where it lives and never leaves the platform.
 *
 * LAWGO_MODE=check — reports three separate facts, because "the call
 * succeeded" alone proves nothing:
 *   1. the secret was read (and whether it carries stray whitespace — the
 *      likely cause if 1 passes and 2 fails);
 *   2. law.go.kr accepted it (a well-formed search result came back);
 *   3. the customs designation notice in force came back with its annexes.
 * The notice XML is saved to the bucket for offline analysis.
 *
 * LAWGO_MODE=elaw — fetches English statute texts (LAWGO_ELAW_MST, comma
 * separated law.go.kr serial numbers) into the bucket.
 * LAWGO_MODE=law — fetches the Korean statutes in force (LAWGO_LAW_IDS, law IDs).
 *
 * Output never contains the OC: logs carry facts and masked snippets only.
 */

import { Storage } from '@google-cloud/storage';
import dotenv from 'dotenv';
import { isMainModule } from './is-main.js';
import { createLawGoClient, describeNetworkError, LawGoError, maskOc, xmlText, type LawGoClient } from './lawgo.js';

export const NOTICE_QUERY = '세관장확인물품';
export const NOTICE_TITLE = '관세법 제226조에 따른 세관장확인물품 및 확인방법 지정고시';
const PREFIX = 'research/lawgo';

type Save = (path: string, text: string) => Promise<void>;
type Log = (info: Record<string, unknown>) => void;

export async function probeHomepage(fetchFn: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const res = await fetchFn('https://www.law.go.kr/', { signal: AbortSignal.timeout(20_000) });
    return { reachable: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { reachable: false, error: describeNetworkError(err), ms: Date.now() - started };
  }
}

export async function runCheck(
  client: LawGoClient,
  oc: string,
  save: Save,
  log: Log,
  opts: { probe?: () => Promise<Record<string, unknown>> } = {},
): Promise<boolean> {
  log({
    event: 'lawgo_check',
    step: 1,
    secret_read: true,
    surrounding_whitespace: oc !== oc.trim(),
    contains_newline: /[\r\n]/.test(oc),
  });

  if (opts.probe) {
    // Without the OC: can this host reach law.go.kr at all? Separates a
    // network block from anything about our credential.
    log({ event: 'lawgo_check', step: '2a', ...(await opts.probe()) });
  }
  const list = await client.search('admrul', { query: NOTICE_QUERY, display: '20', nw: '3' });
  const accepted = list.includes('<AdmRulSearch>') && xmlText(list, 'totalCnt') !== undefined;
  if (!accepted) {
    log({ event: 'lawgo_check', step: 2, accepted: false, response_head: maskOc(list.slice(0, 300), oc) });
    return false;
  }
  const total = Number(xmlText(list, 'totalCnt'));
  log({ event: 'lawgo_check', step: 2, accepted: true, result_code: xmlText(list, 'resultCode') ?? null, total });

  const entry = list
    .split('<admrul id=')
    .slice(1)
    .find((b) => xmlText(b, '행정규칙명') === NOTICE_TITLE);
  const serial = entry ? xmlText(entry, '행정규칙일련번호') : undefined;
  if (!entry || !serial) {
    log({ event: 'lawgo_check', step: 3, found: false, titles: list.split('<admrul id=').slice(1).map((b) => xmlText(b, '행정규칙명')) });
    return false;
  }
  const body = await client.service('admrul', { ID: serial });
  await save(`${PREFIX}/admrul-${serial}.xml`, body);
  const annexTitles = body
    .split('<별표단위')
    .slice(1)
    .map((b) => xmlText(b, '별표제목') ?? '');
  const history = await client.search('admrul', { query: NOTICE_QUERY, display: '100', nw: '2' });
  await save(`${PREFIX}/admrul-history.xml`, history);
  log({
    event: 'lawgo_check',
    step: 3,
    found: true,
    serial,
    issued: xmlText(entry, '발령일자') ?? null,
    number: xmlText(entry, '발령번호') ?? null,
    effective: xmlText(entry, '시행일자') ?? null,
    articles: (body.match(/<조문내용>/g) ?? []).length,
    annexes: annexTitles.length,
    annex_titles: annexTitles,
    history_versions: Number(xmlText(history, 'totalCnt') ?? 0),
    saved: `${PREFIX}/admrul-${serial}.xml`,
  });
  return annexTitles.length > 0;
}

export async function runElaw(client: LawGoClient, msts: string[], save: Save, log: Log): Promise<void> {
  let saved = 0;
  for (const mst of msts) {
    const xml = await client.service('elaw', { MST: mst });
    await save(`${PREFIX}/elaw/${mst}.xml`, xml);
    saved++;
    await new Promise((r) => setTimeout(r, 300));
  }
  log({ event: 'lawgo_elaw', requested: msts.length, saved });
}

/** Korean statute texts in force, by law.go.kr law ID — to align articles with the English versions. */
export async function runLaw(client: LawGoClient, ids: string[], save: Save, log: Log): Promise<void> {
  let saved = 0;
  for (const id of ids) {
    const xml = await client.service('law', { ID: id });
    await save(`${PREFIX}/law/${id}.xml`, xml);
    saved++;
    await new Promise((r) => setTimeout(r, 300));
  }
  log({ event: 'lawgo_law', requested: ids.length, saved });
}

// --- entry point -----------------------------------------------------------

if (process.env.VITEST === undefined && isMainModule(import.meta.url)) {
  dotenv.config({ quiet: true });
  const oc = process.env.LAW_GO_KR_OC;
  const bucket = process.env.SNAPSHOT_BUCKET ?? process.env.NAME_INDEX_BUCKET;
  const log: Log = (info) => console.log(JSON.stringify(info));
  if (!oc) {
    log({ event: 'lawgo_check', step: 1, secret_read: false });
    console.error('FATAL: LAW_GO_KR_OC is not set.');
    process.exit(1);
  }
  if (!bucket) {
    console.error('FATAL: set SNAPSHOT_BUCKET or NAME_INDEX_BUCKET for the fetched files.');
    process.exit(1);
  }
  const b = new Storage().bucket(bucket);
  const save: Save = async (path, text) => {
    await b.file(path).save(maskOc(text, oc), { contentType: 'application/xml; charset=utf-8' });
  };
  try {
    const client = createLawGoClient({ oc });
    const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (process.env.LAWGO_MODE === 'elaw') {
      await runElaw(client, list(process.env.LAWGO_ELAW_MST), save, log);
    } else if (process.env.LAWGO_MODE === 'law') {
      await runLaw(client, list(process.env.LAWGO_LAW_IDS), save, log);
    } else {
      const ok = await runCheck(client, oc, save, log, { probe: () => probeHomepage() });
      if (!ok) process.exit(2);
    }
  } catch (err) {
    const msg = err instanceof LawGoError ? err.message : maskOc(String((err as Error).message), oc);
    console.error(JSON.stringify({ event: 'lawgo_job_failed', error: msg }));
    process.exit(1);
  }
}
