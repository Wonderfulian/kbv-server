/**
 * Tariff schedule and HS item names (TRADE-DESK stage 3).
 *
 * Sources (data.go.kr, KOGL Type 1 — attribution):
 *   - 15051179 관세청_품목번호별 관세율표: one row per (HS code, rate type),
 *     ~380k rows, annual.
 *   - 15130660 관세청_HS부호 단위별 품목명: item names at 2/4/6/8/10 digits.
 *
 * The date trap, again, and worse than in the HS master: 94% of tariff rows
 * end on 2026-12-31 (the edition), but 22k end on 2026-06-30 and a few
 * monthly — those are real expiries — and one rate runs to 2030. The edition
 * end is therefore the MOST COMMON end date (editionEndDate), rows ending on
 * it stay in force until the next edition is loaded (due 2027-01-31, a month
 * after this one runs out), and other end dates are honoured as written.
 *
 * Rate-type codes (A, C, U, F…) are kept raw: their meanings are published
 * only on UNI-PASS, which is not used as a source. A (basic rate) and C (WTO
 * concession) are the two the dataset itself names.
 */

import { editionEndDate, inForce } from './hs-master.js';

export const TARIFF_PATH = 'hs/tariff.json';
export const ITEM_NAMES_PATH = 'hs/item-names.json';

/** The only rate-type meanings the dataset documents itself (data.go.kr 15051179 description). */
export const DOCUMENTED_RATE_TYPES: Record<string, string> = {
  A: 'Basic rate (기본세율)',
  C: 'WTO concession rate (WTO 협정에 의한 양허관세)',
};

/** [type, rate, unit_tax, base_price, country_scope, use_type, fromIdx, toIdx] */
export type TariffRow = [string, string, string, string, string, string, number, number];

export interface TariffFile {
  source: string;
  dataset: string;
  file_name: string;
  fetched_at: string;
  edition_end: string;
  /** ISO dates referenced by index from the rows. */
  dates: string[];
  rates: Record<string, TariffRow[]>;
}

export interface TariffRate {
  type: string;
  /** Percent ad valorem as published (string — some are blank when a unit tax applies). */
  rate: string;
  unit_tax?: string;
  base_price?: string;
  country_scope: string;
  use_type?: string;
  from: string;
  to: string;
}

const TARIFF_HEADERS = {
  hs: '품목번호',
  type: '관세율구분',
  rate: '관세율',
  unitTax: '단위당세액',
  basePrice: '기준가격',
  country: '적용국가구분',
  use: '용도세율구분',
  from: '적용개시일',
  to: '적용만료일',
} as const;

export class TariffError extends Error {}

function ymd(s: string): string | null {
  const d = s.trim();
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null;
}

function columns<K extends string>(header: string[], wanted: Record<K, string>, what: string): Record<K, number> {
  return Object.fromEntries(
    Object.entries(wanted).map(([k, name]) => {
      const i = header.indexOf(name as string);
      if (i < 0) throw new TariffError(`${what} sheet has no "${name}" column`);
      return [k, i];
    }),
  ) as Record<K, number>;
}

export function buildTariffFile(rows: string[][], meta: Omit<TariffFile, 'edition_end' | 'dates' | 'rates'>, minCodes = 10_000): TariffFile {
  const idx = columns(rows[0] ?? [], TARIFF_HEADERS, 'Tariff');
  const dates: string[] = [];
  const dateIdx = new Map<string, number>();
  const di = (d: string) => {
    let i = dateIdx.get(d);
    if (i === undefined) {
      i = dates.push(d) - 1;
      dateIdx.set(d, i);
    }
    return i;
  };
  const rates: Record<string, TariffRow[]> = {};
  const ends: string[] = [];
  for (const r of rows.slice(1)) {
    const hs = (r[idx.hs] ?? '').replace(/\D/g, '');
    if (hs.length !== 10) continue;
    const from = ymd(r[idx.from] ?? '');
    const to = ymd(r[idx.to] ?? '');
    if (!from || !to) throw new TariffError(`tariff row for ${hs} has an unreadable validity period`);
    ends.push(to);
    (rates[hs] ??= []).push([
      (r[idx.type] ?? '').trim(),
      (r[idx.rate] ?? '').trim(),
      (r[idx.unitTax] ?? '').trim(),
      (r[idx.basePrice] ?? '').trim(),
      (r[idx.country] ?? '').trim(),
      (r[idx.use] ?? '').trim(),
      di(from),
      di(to),
    ]);
  }
  const codes = Object.keys(rates).length;
  if (codes < minCodes) throw new TariffError(`tariff schedule covers only ${codes} HS codes (expected at least ${minCodes})`);
  return { ...meta, edition_end: editionEndDate(ends), dates, rates };
}

export class TariffIndex {
  constructor(readonly file: TariffFile) {}

  isStale(today: string): boolean {
    return today > this.file.edition_end;
  }

  /** Rates in force today for a 10-digit code ([] when none). */
  ratesFor(hs: string, today: string): TariffRate[] {
    const out: TariffRate[] = [];
    for (const [type, rate, unitTax, basePrice, country, use, f, t] of this.file.rates[hs] ?? []) {
      const from = this.file.dates[f];
      const to = this.file.dates[t];
      if (!inForce(from, to, today, this.file.edition_end)) continue;
      out.push({
        type,
        rate,
        ...(unitTax ? { unit_tax: unitTax } : {}),
        ...(basePrice ? { base_price: basePrice } : {}),
        country_scope: country,
        ...(use ? { use_type: use } : {}),
        from,
        to,
      });
    }
    return out;
  }
}

// --- item names ---------------------------------------------------------------

export interface ItemNamesFile {
  source: string;
  dataset: string;
  file_name: string;
  fetched_at: string;
  /** code -> [name_ko, name_en], every level (2, 4, 5/6, 7/8/9, 10 digits) in one map. */
  names: Record<string, [string, string]>;
}

export function buildItemNamesFile(sheets: Map<string, string[][]>, meta: Omit<ItemNamesFile, 'names'>): ItemNamesFile {
  const names: Record<string, [string, string]> = {};
  for (const [tab, rows] of sheets) {
    const header = rows[0] ?? [];
    const code = header.findIndex((h) => /^HS\d+단위$/.test(h));
    const ko = header.indexOf('한글품목명');
    const en = header.indexOf('영문품목명');
    if (code < 0 || ko < 0 || en < 0) throw new TariffError(`item-name sheet "${tab}" lacks its code/name columns`);
    for (const r of rows.slice(1)) {
      const c = (r[code] ?? '').replace(/\D/g, '');
      if (c) names[c] = [(r[ko] ?? '').trim(), (r[en] ?? '').trim()];
    }
  }
  if (!Object.keys(names).some((c) => c.length === 2) || !Object.keys(names).some((c) => c.length === 10)) {
    throw new TariffError('item-name workbook is missing its 2-digit or 10-digit level');
  }
  return { ...meta, names };
}

/** Names from chapter down to the code itself — "Other" alone tells an agent nothing. */
export function itemPath(file: ItemNamesFile, hs: string): { code: string; name_ko: string; name_en: string }[] {
  const out: { code: string; name_ko: string; name_en: string }[] = [];
  for (const len of [2, 4, 5, 6, 7, 8, 9, 10]) {
    const c = hs.slice(0, len);
    const n = file.names[c];
    if (n && (out.length === 0 || out[out.length - 1].code !== c)) out.push({ code: c, name_ko: n[0], name_en: n[1] });
  }
  return out;
}
