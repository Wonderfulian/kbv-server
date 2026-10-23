/**
 * Conditions quoted from the customs designation notice (TRADE-DESK §3.2).
 *
 * The requirements API says WHICH statute applies to an HS code, not under
 * what condition ("only food-contact parts", "rated 30–1000 V, up to 10 kW").
 * The notice's attachment spreadsheets do: annex 2의2 (import) and 1의2
 * (export) list, per 10-digit HS code and statute, the condition text.
 *
 * Join key: (HS code, law.go.kr law ID). The API's statute code and the
 * spreadsheet's statute title are both resolved to the law ID through the
 * dictionary — never title-to-title, which breaks on a space or a corrupted
 * character (the notice's own annex has "제조?수출입" where a middle dot was).
 * Rows whose statute does not resolve are counted, not dropped silently.
 *
 * Text is quoted verbatim apart from line-ending normalisation: the Ministry
 * of Government Legislation's terms forbid altering it, and the attribution
 * line must accompany every quotation.
 */

import { lawIdForDamagedTitle, resolveStatute } from './trade-dict.js';

export const CONDITIONS_PATH = 'hs/conditions.json';
/** Written by every successful amendment watch, changed or not. */
export const NOTICE_WATCH_PATH = 'hs/notice-watch.json';
/**
 * The watch runs daily. Three days without a successful check means
 * consecutive failures, and the index may be falling behind the notice
 * without anyone noticing — so responses and logs say so from then on.
 */
export const WATCH_STALE_DAYS = 3;

export interface NoticeWatchFile {
  /** When law.go.kr last answered the in-force check (ISO). */
  checked_at: string;
  /** The notice revision in force at that moment. */
  live_serial: string;
  live_notice_no: string;
  /** The revision the condition index was built from, after any rebuild in that run. */
  indexed_serial: string;
  rebuilt: boolean;
}

/** Whole days since the last successful watch; null when it has never succeeded. */
export function watchAgeDays(watch: NoticeWatchFile | null | undefined, now: Date): number | null {
  if (!watch) return null;
  return Math.floor((now.getTime() - Date.parse(watch.checked_at)) / 86_400_000);
}

export interface NoticeInfo {
  name_ko: string;
  /** e.g. 제2026-46호 */
  notice_no: string;
  /** ISO date the revision took effect. */
  effective_from: string;
  /** law.go.kr administrative-rule serial (행정규칙일련번호). */
  serial: string;
  url: string;
}

/**
 * One statute's row of annex 2 (import) or 1 (export), as its items: the
 * scope ("대상법령 및 물품의 범위") beside the documents it needs ("구비요건").
 * The first item is usually the statute heading, with no documents.
 */
export interface StatuteGroup {
  items: { scope_ko: string; documents_ko: string }[];
}

export interface ConditionsFile {
  notice: NoticeInfo;
  built_at: string;
  files: { import: string; export: string };
  /** "<hs10>|<law_id>" -> verbatim condition text. */
  import: Record<string, string>;
  export: Record<string, string>;
  unresolved: { import: number; export: number; samples: string[] };
  /**
   * law ID -> the statute's row in the notice body (annex 2 import, annex 1
   * export). The fallback when the HS-level spreadsheet has no row for a pair:
   * coarser (it covers every item under the statute), and said so.
   * Absent in files built before stage 5.
   */
  statute_groups?: {
    import: Record<string, StatuteGroup>;
    export: Record<string, StatuteGroup>;
    unresolved: string[];
  };
}

export class ConditionsError extends Error {}

/** Line endings only; nothing else about the quoted text changes. */
export function normalizeConditionText(s: string): string {
  return s.replace(/\r\n?/g, '\n').trim();
}

/**
 * Rows of one attachment sheet -> key/text map. The header row is found by
 * name (품목번호 … 관계법령); the title row above it is skipped.
 */
export function indexConditionRows(rows: string[][]): { map: Record<string, string>; unresolved: string[]; rows: number } {
  const h = rows.findIndex((r) => r.some((c) => c.replace(/\s/g, '') === '품목번호') && r.some((c) => c.replace(/\s/g, '') === '관계법령'));
  if (h < 0) throw new ConditionsError('attachment sheet has no 품목번호/관계법령 header row');
  const header = rows[h].map((c) => c.replace(/\s/g, ''));
  const hsCol = header.indexOf('품목번호');
  const lawCol = header.indexOf('관계법령');
  const textCol = header.findIndex((c) => c.includes('요건'));
  if (textCol < 0) throw new ConditionsError('attachment sheet has no 요건 column');

  const map: Record<string, string> = {};
  const unresolved: string[] = [];
  let count = 0;
  for (const r of rows.slice(h + 1)) {
    const hs = (r[hsCol] ?? '').replace(/\D/g, '');
    if (hs.length !== 10) continue;
    count++;
    const law = (r[lawCol] ?? '').trim();
    const text = normalizeConditionText(r[textCol] ?? '');
    const lawId = resolveStatute('__', law).law_id;
    if (!lawId) {
      unresolved.push(`${hs} ${law}`.slice(0, 80));
      continue;
    }
    const key = `${hs}|${lawId}`;
    // The same pair can appear twice; keep both texts, in sheet order.
    map[key] = map[key] && map[key] !== text ? `${map[key]}\n\n${text}` : text;
  }
  return { map, unresolved, rows: count };
}

/** Annex body from the notice XML (lawService admrul), as its CDATA lines. */
export function annexLines(noticeXml: string, title: string): string[] {
  for (const unit of noticeXml.split('<별표단위').slice(1)) {
    const t = /<별표제목>([\s\S]*?)<\/별표제목>/.exec(unit)?.[1] ?? '';
    if (!cdata(t).join('').includes(title)) continue;
    const body = /<별표내용>([\s\S]*?)<\/별표내용>/.exec(unit)?.[1] ?? '';
    return cdata(body).filter((l) => l !== '');
  }
  throw new ConditionsError(`the notice has no annex titled ${title}`);
}

function cdata(s: string): string[] {
  const parts = [...s.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  return parts.length ? parts : [s.trim()];
}

/**
 * Statute rows of the notice's box-drawn table ("가. 대상법령 및 물품의 범위와
 * 구비요건"). A row starts with "(n)「statute」"; a row cut by a page break
 * continues in the next table. Within a row, a line blank in both columns
 * separates items, so "(가) 안전인증대상 제품" stays paired with its document.
 * Lines keep the annex's own layout (a word can be split across lines) — only
 * the padding inside the box is trimmed, since rejoining wrapped lines would
 * mean guessing where the spaces were.
 */
export function indexAnnexRows(lines: string[]): { map: Record<string, StatuteGroup>; unresolved: string[]; rows: number } {
  type Block = { left: string[]; right: string[] };
  const rows: Block[][] = [];
  let row: Block[] | undefined;
  let block: Block | undefined;
  let open = false;
  for (const line of lines) {
    if (/^[┌├└]/.test(line)) {
      open = !line.startsWith('└');
      row = undefined;
      block = undefined;
      continue;
    }
    if (!open || !line.startsWith('│')) continue;
    const cells = line.split('│');
    const left = (cells[1] ?? '').trimEnd();
    const right = (cells[2] ?? '').trimEnd();
    if (/^대상법령및물품의범위/.test(left.replace(/\s/g, ''))) continue; // repeated header
    if (!left.trim() && !right.trim()) {
      block = undefined;
      continue;
    }
    if (!row) {
      // First line after a rule: a new statute row, or the tail of one split by a page break.
      const continues = !/^\(\d+\)/.test(left.trim()) && rows.length > 0;
      row = continues ? rows[rows.length - 1] : [];
      if (!continues) rows.push(row);
    }
    if (!block) row.push((block = { left: [], right: [] }));
    if (left.trim()) block.left.push(left);
    if (right.trim()) block.right.push(right);
  }

  const map: Record<string, StatuteGroup> = {};
  const unresolved: string[] = [];
  let count = 0;
  for (const r of rows) {
    const flat = r.map((b) => b.left.join('')).join('');
    if (!/^\(\d+\)/.test(flat.trim())) continue;
    const name = /「([^」]+)」/.exec(flat)?.[1];
    if (!name) continue; // "(4) (삭제)"
    count++;
    const lawId = resolveStatute('__', name).law_id ?? lawIdForDamagedTitle(name);
    if (!lawId) {
      unresolved.push(name.slice(0, 80));
      continue;
    }
    const items = r.map((b) => ({ scope_ko: b.left.join('\n'), documents_ko: b.right.join('\n') }));
    map[lawId] = { items: [...(map[lawId]?.items ?? []), ...items] };
  }
  return { map, unresolved, rows: count };
}

export class ConditionsIndex {
  constructor(readonly file: ConditionsFile) {}

  lookup(direction: 'import' | 'export', hs: string, lawId: string | undefined): string | undefined {
    if (!lawId) return undefined;
    return this.file[direction][`${hs}|${lawId}`];
  }

  statuteGroup(direction: 'import' | 'export', lawId: string | undefined): StatuteGroup | undefined {
    if (!lawId) return undefined;
    return this.file.statute_groups?.[direction][lawId];
  }
}
