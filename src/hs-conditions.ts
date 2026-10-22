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

import { resolveStatute } from './trade-dict.js';

export const CONDITIONS_PATH = 'hs/conditions.json';

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

export interface ConditionsFile {
  notice: NoticeInfo;
  built_at: string;
  files: { import: string; export: string };
  /** "<hs10>|<law_id>" -> verbatim condition text. */
  import: Record<string, string>;
  export: Record<string, string>;
  unresolved: { import: number; export: number; samples: string[] };
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

export class ConditionsIndex {
  constructor(readonly file: ConditionsFile) {}

  lookup(direction: 'import' | 'export', hs: string, lawId: string | undefined): string | undefined {
    if (!lawId) return undefined;
    return this.file[direction][`${hs}|${lawId}`];
  }
}
