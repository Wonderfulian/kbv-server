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
 * LAWGO_MODE=conditions — builds hs/conditions.json from the notice's attachment spreadsheets
 * and the statute rows of its body (annexes 1 and 2).
 * LAWGO_MODE=watch — amendment detection: rebuilds the index only when the notice in force changed.
 *
 * Output never contains the OC: logs carry facts and masked snippets only.
 */

import { Storage } from '@google-cloud/storage';
import dotenv from 'dotenv';
import { isMainModule } from './is-main.js';
import {
  annexLines,
  CONDITIONS_PATH,
  ConditionsError,
  indexAnnexRows,
  indexConditionRows,
  type ConditionsFile,
  type NoticeInfo,
} from './hs-conditions.js';
import { createLawGoClient, describeNetworkError, LawGoError, maskOc, xmlText, type LawGoClient } from './lawgo.js';
import { GcsNameIndexStore, type NameIndexStore } from './name-index-store.js';
import { RetryableError, withRetry } from './retry.js';
import { readFirstSheet } from './xlsx.js';

export const NOTICE_QUERY = '세관장확인물품';
export const NOTICE_TITLE = '관세법 제226조에 따른 세관장확인물품 및 확인방법 지정고시';
const PREFIX = 'research/lawgo';
/** Annex titles in the notice body (statute rows per direction). */
export const ANNEX_TITLES = { import: '세관장확인대상 수입물품', export: '세관장확인대상 수출물품' } as const;

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

/** Current revision of the designation notice, from the in-force search. */
export async function currentNotice(client: LawGoClient): Promise<NoticeInfo> {
  const list = await client.search('admrul', { query: NOTICE_QUERY, display: '20', nw: '3' });
  const entry = list
    .split('<admrul id=')
    .slice(1)
    .find((b) => xmlText(b, '행정규칙명') === NOTICE_TITLE);
  const serial = entry ? xmlText(entry, '행정규칙일련번호') : undefined;
  if (!entry || !serial) throw new ConditionsError('the designation notice is not in the law.go.kr in-force list');
  const ymd = (s: string | undefined) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : '');
  return {
    name_ko: NOTICE_TITLE,
    notice_no: `제${xmlText(entry, '발령번호') ?? ''}호`,
    effective_from: ymd(xmlText(entry, '시행일자')),
    serial,
    url: `https://www.law.go.kr/admRulLsInfoP.do?admRulSeq=${serial}`,
  };
}

/** Public attachment list of an administrative rule (no OC): [name, download URL]. */
export function parseAttachmentList(html: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of html.split('<a href="').slice(1)) {
    const href = part.slice(0, part.indexOf('"'));
    const b = part.indexOf('<b>');
    const e = part.indexOf('</b>');
    if (!href.startsWith('flDownload.do') || b < 0 || e < b) continue;
    out.push([part.slice(b + 3, e).trim(), `https://www.law.go.kr/LSW/${href}`]);
  }
  return out;
}

/**
 * Builds hs/conditions.json from the notice in force: its number and date
 * from law.go.kr (our OC), its attachment spreadsheets from the public
 * attachment list. Network failures are retried; a missing attachment or an
 * unreadable sheet fails the run instead of writing a partial index.
 */
export async function runConditions(
  client: LawGoClient,
  store: NameIndexStore,
  log: Log,
  fetchFn: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<ConditionsFile> {
  const notice = await currentNotice(client);
  const get = (url: string, init?: RequestInit) =>
    withRetry(async () => {
      let res: Response;
      try {
        res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(120_000) });
      } catch (err) {
        throw new RetryableError(`law.go.kr download failed: ${describeNetworkError(err)}`);
      }
      if (res.status >= 500) throw new RetryableError(`law.go.kr download HTTP ${res.status}`);
      if (!res.ok) throw new ConditionsError(`law.go.kr download HTTP ${res.status}`);
      return res;
    });
  const listHtml = await (
    await get('https://www.law.go.kr/LSW/admRulAttFlList.do', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ admRulSeq: notice.serial }),
    })
  ).text();
  const files = parseAttachmentList(listHtml);
  const pick = (annex: string) => {
    const f = files.find(([name]) => name.includes(annex) && name.toLowerCase().endsWith('.xlsx'));
    if (!f) throw new ConditionsError(`notice ${notice.notice_no} has no ${annex} spreadsheet among its attachments`);
    return f;
  };
  const sides = { import: pick('별표 2의2'), export: pick('별표 1의2') } as const;

  // The notice body's statute rows: the fallback when a pair has no HS-level row.
  const noticeXml = await client.service('admrul', { ID: notice.serial });
  const groups = { import: indexAnnexRows(annexLines(noticeXml, ANNEX_TITLES.import)), export: indexAnnexRows(annexLines(noticeXml, ANNEX_TITLES.export)) };
  for (const side of ['import', 'export'] as const) {
    const g = groups[side];
    log({ event: 'conditions_annex', side, rows: g.rows, statutes: Object.keys(g.map).length, unresolved: g.unresolved.length });
  }

  const built: Partial<Record<'import' | 'export', Record<string, string>>> = {};
  const unresolved: string[] = [];
  const counts = { import: 0, export: 0 };
  for (const side of ['import', 'export'] as const) {
    const [, url] = sides[side];
    const body = Buffer.from(await (await get(url)).arrayBuffer());
    const { map, unresolved: u, rows } = indexConditionRows(readFirstSheet(body));
    built[side] = map;
    counts[side] = u.length;
    unresolved.push(...u.slice(0, 10));
    log({ event: 'conditions_sheet', side, rows, pairs: Object.keys(map).length, unresolved: u.length });
  }
  const file: ConditionsFile = {
    notice,
    built_at: now().toISOString(),
    files: { import: sides.import[0], export: sides.export[0] },
    import: built.import ?? {},
    export: built.export ?? {},
    unresolved: { ...counts, samples: unresolved },
    statute_groups: {
      import: groups.import.map,
      export: groups.export.map,
      unresolved: [...groups.import.unresolved, ...groups.export.unresolved],
    },
  };
  await store.writeJson(CONDITIONS_PATH, file, { compact: true });
  log({ event: 'conditions_built', notice_no: notice.notice_no, effective_from: notice.effective_from, unresolved: counts });
  return file;
}

/**
 * Amendment watch: one law.go.kr search for the notice in force, compared
 * with the revision the condition index was built from. Unchanged → a log
 * line and nothing else. Changed (or no index yet) → rebuild the index, so
 * quoted conditions never lag the notice by more than one watch interval.
 * A rebuild that cannot read the new revision's attachments fails the run
 * loudly rather than leaving the old index in place silently.
 */
export async function runWatch(
  client: LawGoClient,
  store: NameIndexStore,
  log: Log,
  rebuild: () => Promise<ConditionsFile> = () => runConditions(client, store, log),
): Promise<{ changed: boolean }> {
  const live = await currentNotice(client);
  const built = await store.readJson<ConditionsFile>(CONDITIONS_PATH);
  const was = built?.notice;
  const changed = !was || was.serial !== live.serial || !built?.statute_groups;
  log({
    event: 'notice_watch',
    changed,
    live: { serial: live.serial, notice_no: live.notice_no, effective_from: live.effective_from },
    indexed: was ? { serial: was.serial, notice_no: was.notice_no, effective_from: was.effective_from } : null,
    ...(was && was.serial === live.serial && !built?.statute_groups ? { reason: 'index predates statute groups' } : {}),
  });
  if (changed) await rebuild();
  return { changed };
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
    } else if (process.env.LAWGO_MODE === 'conditions') {
      await runConditions(client, new GcsNameIndexStore(bucket), log);
    } else if (process.env.LAWGO_MODE === 'watch') {
      await runWatch(client, new GcsNameIndexStore(bucket), log);
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
