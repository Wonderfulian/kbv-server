/**
 * Tariff schedule + item names (TRADE-DESK stage 3), with the date trap the
 * real 2026 file carries: most rows end on the edition's blanket date, some
 * end mid-year for real, and one runs past the edition.
 */

import { describe, expect, it } from 'vitest';
import { editionEndDate } from '../src/hs-master.js';
import { buildItemNamesFile, buildTariffFile, itemPath, TariffError, TariffIndex } from '../src/tariff.js';

const H = ['품목번호', '관세율구분', '관세율', '단위당세액', '기준가격', '적용국가구분', '용도세율구분', '적용개시일', '적용만료일'];
const META = { source: 'test', dataset: '15051179', file_name: '관세청_품목번호별 관세율표_20260211', fetched_at: '2026-10-21T00:00:00Z' };
const ROWS = [
  H,
  ['8516710000', 'A', '8', '', '', '1', '', '20260101', '20261231'],
  ['8516710000', 'FUS1', '0', '', '', '2', '', '20260101', '20261231'],
  ['8516710000', 'FEU1', '0', '', '', '2', '', '20260101', '20260630'], // real mid-year expiry
  ['8516720000', 'A', '8', '', '', '1', '', '20260101', '20261231'],
  ['7225409010', 'I', '0', '', '', '1', '', '20251124', '20301123'], // runs past the edition
  ['0101211000', 'A', '0', '', '', '1', '', '20261001', '20261231'], // starts mid-year
];
const index = () => new TariffIndex(buildTariffFile(ROWS, META, 1));

describe('edition end date', () => {
  it('is the most common end date, not the latest', () => {
    expect(editionEndDate(['2026-12-31', '2026-12-31', '2030-11-23', '2026-06-30'])).toBe('2026-12-31');
    expect(index().file.edition_end).toBe('2026-12-31');
  });
});

describe('TariffIndex.ratesFor', () => {
  it('returns the rates in force, with the published fields', () => {
    const r = index().ratesFor('8516710000', '2026-05-01');
    expect(r.map((x) => x.type)).toEqual(['A', 'FUS1', 'FEU1']);
    expect(r[0]).toEqual({ type: 'A', rate: '8', country_scope: '1', from: '2026-01-01', to: '2026-12-31' });
  });

  it('honours a real mid-year expiry', () => {
    expect(index().ratesFor('8516710000', '2026-10-21').map((x) => x.type)).toEqual(['A', 'FUS1']);
  });

  it('keeps serving edition-end rows after the edition runs out, flagged stale (next edition is due a month later)', () => {
    const t = index();
    expect(t.ratesFor('8516710000', '2027-01-15').map((x) => x.type)).toEqual(['A', 'FUS1']);
    expect(t.isStale('2027-01-15')).toBe(true);
    expect(t.isStale('2026-12-31')).toBe(false);
  });

  it('does not let a rate that runs past the edition shift the edition end', () => {
    expect(index().ratesFor('7225409010', '2028-01-01')).toHaveLength(1);
    expect(index().ratesFor('8516720000', '2027-06-01')).toHaveLength(1); // still the edition-end reading
  });

  it('respects a start date later in the year', () => {
    expect(index().ratesFor('0101211000', '2026-09-30')).toEqual([]);
    expect(index().ratesFor('0101211000', '2026-10-01')).toHaveLength(1);
  });

  it('answers an unknown code with no rates', () => {
    expect(index().ratesFor('9999999999', '2026-10-21')).toEqual([]);
  });

  it('fails loudly on a renamed column or a short file', () => {
    expect(() => buildTariffFile([H.map((h) => (h === '관세율' ? '세율' : h)), ...ROWS.slice(1)], META, 1)).toThrow(TariffError);
    expect(() => buildTariffFile(ROWS, META, 10_000)).toThrow(/only 4 HS codes/);
  });
});

describe('item names', () => {
  const sheets = new Map<string, string[][]>([
    ['HS2단위', [['HS2단위', '한글품목명', '영문품목명'], ['85', '제85류 전기기기', 'Electrical machinery']]],
    ['HS4단위', [['HS4단위', '한글품목명', '영문품목명'], ['8516', '전기 가열기기', 'Electric heaters']]],
    ['HS6단위(5단위포함)', [['HS6단위', '한글품목명', '영문품목명'], ['85167', '기타 전열기기', 'Other electro-thermic appliances']]],
    ['HS10단위', [['HS10단위', '한글품목명', '영문품목명'], ['8516710000', '커피ㆍ차를 끓이는 기기', 'Coffee or tea makers']]],
  ]);
  const file = buildItemNamesFile(sheets, { source: 't', dataset: '15130660', file_name: 'x', fetched_at: 'x' });

  it('reads every level and builds the path from chapter to code', () => {
    expect(itemPath(file, '8516710000').map((p) => p.code)).toEqual(['85', '8516', '85167', '8516710000']);
    expect(itemPath(file, '8516710000').at(-1)?.name_en).toBe('Coffee or tea makers');
  });

  it('fails when a level is missing', () => {
    expect(() => buildItemNamesFile(new Map([...sheets].filter(([k]) => k !== 'HS10단위')), file)).toThrow(TariffError);
  });
});
