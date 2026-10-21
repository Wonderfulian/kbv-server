/**
 * HS code master (Korea Customs Service "HS부호", data.go.kr dataset 15049722).
 *
 * Why this exists: the customs requirements API answers a code that does not
 * exist — `9999999999`, or a 4-digit heading — with exactly the same "200,
 * normal service, no items" it gives a real product that needs no approval.
 * A typo would read as "clear to ship". So every lookup checks the code
 * against the official master first, and an unknown code is refused before
 * the upstream is called and before any payment is taken.
 *
 * A 6-digit (international HS subheading) input is not guessed at: it gets
 * the 10-digit Korean (HSK) codes under it, and the caller narrows it down —
 * the same "no single guessed answer" rule as the company name search.
 *
 * The master is rebuilt once a year (the source is annual) by
 * hs-master-job.ts and stored as one JSON file next to the name index.
 */

export const HS_MASTER_PATH = 'hs/hs-master.json';

/** code -> [name_ko, name_en, valid_from, valid_to] (ISO dates). */
export type HsRow = [string, string, string, string];

export interface HsMasterFile {
  source: string;
  dataset: string;
  /** Upstream file name, e.g. 관세청_HS부호_20260101 — carries the edition. */
  file_name: string;
  fetched_at: string;
  /** Every coded row the file lists: 10-digit HSK codes and the 7/8-digit groupings above them. */
  codes: Record<string, HsRow>;
}

export interface HsCandidate {
  hs_code: string;
  name_ko: string;
  name_en: string;
  /** Nearest grouping row above the code, when the master has one — "Other" alone tells nothing. */
  group_ko?: string;
  group_en?: string;
}

export type HsLookup =
  | { kind: 'valid'; hs_code: string; name_ko: string; name_en: string; valid_from: string; valid_to: string }
  | { kind: 'candidates'; prefix: string; candidates: HsCandidate[] }
  | { kind: 'not_found'; hs_code: string }
  | { kind: 'invalid_input'; message: string };

/** Digits only; dots, hyphens and spaces are accepted as separators. */
export function normalizeHsInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const stripped = input.replace(/[\s.\-]/g, '');
  return /^\d+$/.test(stripped) ? stripped : null;
}

/**
 * The date an annual KCS table stamps on (nearly) every row: the edition's
 * validity, not a per-row expiry. It is the MOST COMMON end date, not the
 * latest — the 2026 tariff schedule has one rate running to 2030, and taking
 * the maximum would turn every 2026-12-31 row into a "real" expiry.
 */
export function editionEndDate(endDates: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const d of endDates) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = '';
  let bestCount = -1;
  for (const [d, n] of counts) {
    if (n > bestCount || (n === bestCount && d > best)) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** In force today, reading the edition's blanket end date as "until the next edition". */
export function inForce(from: string, to: string, today: string, editionEnd: string): boolean {
  if (from > today) return false;
  return to >= today || to === editionEnd;
}

export class HsMaster {
  private readonly rows: Map<string, HsRow>;
  /**
   * The edition's blanket end date. Every row of the 2026 file ends on
   * 2026-12-31: that is the edition's validity, not each code's repeal. Taken
   * literally, every lookup would fail on 1 January until the next file is
   * loaded (the tariff schedule's next edition is not due until 31 January) —
   * so only an end date other than this counts as a repeal.
   */
  readonly editionEnd: string;

  constructor(readonly file: HsMasterFile) {
    this.rows = new Map(Object.entries(file.codes));
    this.editionEnd = editionEndDate([...this.rows.values()].map((r) => r[3]));
  }

  /** True once the edition has run out: the annual rebuild is overdue. */
  isStale(today: string): boolean {
    return today > this.editionEnd;
  }

  /** Number of 10-digit codes (what a caller can actually look up). */
  get size(): number {
    let n = 0;
    for (const code of this.rows.keys()) if (code.length === 10) n++;
    return n;
  }

  private inForce(row: HsRow, today: string): boolean {
    return inForce(row[2], row[3], today, this.editionEnd);
  }

  private group(code: string): Pick<HsCandidate, 'group_ko' | 'group_en'> {
    for (const len of [8, 7]) {
      const g = this.rows.get(code.slice(0, len));
      if (g) return { group_ko: g[0], group_en: g[1] };
    }
    return {};
  }

  /**
   * `today` is an ISO date (YYYY-MM-DD) so a code that has lapsed or not yet
   * taken effect is not reported as valid.
   */
  lookup(input: unknown, today: string): HsLookup {
    const code = normalizeHsInput(input);
    if (code === null) {
      return { kind: 'invalid_input', message: 'HS code must be digits (dots, hyphens and spaces are allowed).' };
    }
    if (code.length === 10) {
      const row = this.rows.get(code);
      if (!row || !this.inForce(row, today)) return { kind: 'not_found', hs_code: code };
      return { kind: 'valid', hs_code: code, name_ko: row[0], name_en: row[1], valid_from: row[2], valid_to: row[3] };
    }
    if (code.length === 6) {
      const candidates: HsCandidate[] = [];
      for (const [c, row] of this.rows) {
        if (c.length === 10 && c.startsWith(code) && this.inForce(row, today)) {
          candidates.push({ hs_code: c, name_ko: row[0], name_en: row[1], ...this.group(c) });
        }
      }
      if (candidates.length === 0) return { kind: 'not_found', hs_code: code };
      candidates.sort((a, b) => a.hs_code.localeCompare(b.hs_code));
      return { kind: 'candidates', prefix: code, candidates };
    }
    // 4-digit headings, 8-digit groupings and everything else: not a
    // lookup-able code. Same answer as a code that does not exist.
    return { kind: 'not_found', hs_code: code };
  }
}

/** Excel serial day (1900 date system) -> YYYY-MM-DD. */
function excelDate(serial: string): string | null {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000).toISOString().slice(0, 10);
}

const HEADERS = { code: 'HS부호', from: '적용시작일자', to: '적용종료일자', ko: '한글품목명', en: '영문품목명' } as const;

export class HsMasterError extends Error {}

/**
 * Build the master from the upstream sheet. Columns are found by header name,
 * not position, so a reordered edition fails loudly instead of loading
 * shifted data.
 */
export function buildHsMasterFile(
  rows: string[][],
  meta: Omit<HsMasterFile, 'codes'>,
  minCodes = 10_000,
): HsMasterFile {
  const header = rows[0] ?? [];
  const idx = Object.fromEntries(
    Object.entries(HEADERS).map(([k, name]) => {
      const i = header.indexOf(name);
      if (i < 0) throw new HsMasterError(`HS master sheet has no "${name}" column`);
      return [k, i];
    }),
  ) as Record<keyof typeof HEADERS, number>;

  const codes: Record<string, HsRow> = {};
  for (const r of rows.slice(1)) {
    const code = (r[idx.code] ?? '').trim();
    if (!/^\d{7,10}$/.test(code)) continue;
    const from = excelDate(r[idx.from] ?? '');
    const to = excelDate(r[idx.to] ?? '');
    if (!from || !to) throw new HsMasterError(`HS ${code} has an unreadable validity period`);
    const row: HsRow = [(r[idx.ko] ?? '').trim(), (r[idx.en] ?? '').trim(), from, to];
    const prev = codes[code];
    // A code listed twice (two validity periods) keeps the later period.
    if (!prev || prev[3] < row[3]) codes[code] = row;
  }
  const tenDigit = Object.keys(codes).filter((c) => c.length === 10).length;
  if (tenDigit < minCodes) {
    throw new HsMasterError(`HS master has only ${tenDigit} 10-digit codes (expected at least ${minCodes})`);
  }
  return { ...meta, codes };
}
