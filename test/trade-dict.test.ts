/**
 * English dictionary for clearance requirements (TRADE-DESK stage 2).
 *
 * What must hold: every English name is an official one with a recorded
 * source, anything unconfirmed is null rather than translated, unknown codes
 * are reported, and the dictionary can tell when the notice it was checked
 * against has been revised.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENCIES,
  type DictMiss,
  resolveAgency,
  resolveCertificate,
  resolveStatute,
  REVIEW,
  reviewDue,
  STATUTES,
} from '../src/trade-dict.js';

describe('statutes', () => {
  it('resolves an API code to the official English title and law.go.kr ID', () => {
    expect(resolveStatute('23', '전기용품 및 생활용품 안전관리법')).toEqual({
      code: '23',
      name_ko: '전기용품 및 생활용품 안전관리법',
      name_en: 'Electrical Appliances and Consumer Products Safety Control Act',
      law_id: '001459',
    });
  });

  it('keeps the API qualifier in Korean instead of translating it', () => {
    expect(resolveStatute('71', '야생생물 보호 및 관리에 관한 법률(허가)')).toMatchObject({
      name_en: 'Wildlife Protection and Management Act',
      qualifier_ko: '허가',
    });
  });

  it('falls back to the Korean title for a new code, and reports the code', () => {
    const misses: DictMiss[] = [];
    const r = resolveStatute('99', '외국환거래법', (m) => misses.push(m));
    expect(r.name_en).toBe('Foreign Exchange Transactions Act');
    expect(misses).toEqual([{ kind: 'statute', code: '99', matched_by_title: true }]);
  });

  it('matches titles across spacing and middle-dot variants (the API writes ･)', () => {
    expect(resolveStatute('98', '총포･도검･화약류 등의 안전관리에 관한 법률').name_en).toBe(
      'Act on the Safety Management of Guns, Swords, and Explosives',
    );
  });

  it('returns null English for an unknown statute — never a translation', () => {
    const misses: DictMiss[] = [];
    expect(resolveStatute('99', '가상의 법률', (m) => misses.push(m))).toEqual({ code: '99', name_ko: '가상의 법률', name_en: null });
    expect(misses).toEqual([{ kind: 'statute', code: '99', matched_by_title: false }]);
  });

  it('records a law.go.kr ID and English-version date for every statute', () => {
    for (const s of Object.values(STATUTES)) {
      expect(s.law_id).toMatch(/^\d{6}$/);
      expect(s.en_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('agencies', () => {
  it('describes the agency as it is now when the API sends a former name', () => {
    expect(resolveAgency('016', '노동부')).toEqual({
      code: '016',
      name_ko: '고용노동부',
      name_en: 'Ministry of Employment and Labor',
      status: 'renamed',
    });
  });

  it('marks the 2026 merged local governments and gives no English name', () => {
    for (const code of ['022', '030']) {
      expect(resolveAgency(code, 'x')).toMatchObject({ name_en: null, status: 'merged' });
    }
  });

  it('keeps the division the API names, untranslated', () => {
    expect(resolveAgency('107', '농림축산검역본부(식물)')).toMatchObject({
      name_en: 'Animal and Plant Quarantine Agency',
      division_ko: '식물',
    });
  });

  it('returns the API Korean name and null English for an unknown code, and reports it', () => {
    const misses: DictMiss[] = [];
    expect(resolveAgency('999', '새 기관', (m) => misses.push(m))).toEqual({ code: '999', name_ko: '새 기관', name_en: null });
    expect(misses).toEqual([{ kind: 'agency', code: '999' }]);
  });

  it('has a source page for every English name, and none without one', () => {
    for (const [code, a] of Object.entries(AGENCIES)) {
      if (a.name_en) expect(a.source, code).toMatch(/^https?:\/\//);
      else expect(a.source, code).toBeNull();
    }
  });
});

describe('certificates and review', () => {
  it('returns certificate names in Korean only', () => {
    expect(resolveCertificate(' 수입식품등 수입신고확인증 ')).toEqual({ name_ko: '수입식품등 수입신고확인증', name_en: null });
  });

  it('flags a requirement that took effect after the notice revision it was reviewed against', () => {
    expect(REVIEW.notice_effective).toBe('2026-07-16');
    expect(reviewDue('20260716')).toBe(false);
    expect(reviewDue('20200406')).toBe(false);
    expect(reviewDue('20270101')).toBe(true);
  });
});
