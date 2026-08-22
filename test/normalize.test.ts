import { describe, expect, it } from 'vitest';
import {
  buildStatusResult,
  InvalidInputError,
  mapStatus,
  mapTaxType,
  normalizeBusinessNumber,
  toIsoDate,
  toNtsDate,
} from '../src/normalize.js';

describe('normalizeBusinessNumber', () => {
  it('accepts a plain 10-digit number', () => {
    expect(normalizeBusinessNumber('1234567890')).toBe('1234567890');
  });

  it('strips hyphens and spaces', () => {
    expect(normalizeBusinessNumber('123-45-67890')).toBe('1234567890');
    expect(normalizeBusinessNumber(' 123 45 67890 ')).toBe('1234567890');
  });

  it.each(['123456789', '12345678901', '12345abc90', '', '123-45-6789O'])(
    'rejects %j with InvalidInputError',
    (input) => {
      expect(() => normalizeBusinessNumber(input)).toThrow(InvalidInputError);
      expect(() => normalizeBusinessNumber(input)).toThrow(/10-digit/);
    },
  );
});

describe('date conversion', () => {
  it('toIsoDate converts YYYYMMDD to ISO', () => {
    expect(toIsoDate('20230131')).toBe('2023-01-31');
  });

  it('toIsoDate returns null for empty/missing/malformed values', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate('2023-01')).toBeNull();
  });

  it('toNtsDate converts ISO to YYYYMMDD', () => {
    expect(toNtsDate('1999-05-01')).toBe('19990501');
  });

  it('toNtsDate rejects non-ISO formats', () => {
    expect(() => toNtsDate('1999/05/01')).toThrow(InvalidInputError);
    expect(() => toNtsDate('19990501')).toThrow(InvalidInputError);
  });
});

describe('mapStatus', () => {
  it.each([
    ['01', 'active'],
    ['02', 'suspended'],
    ['03', 'closed'],
  ] as const)('maps b_stt_cd %s to %s', (code, expected) => {
    expect(mapStatus({ b_no: '1234567890', b_stt_cd: code })).toEqual({ status: expected, raw: code });
  });

  it('maps the unregistered shape (empty b_stt_cd + NTS message) to not_registered', () => {
    const item = {
      b_no: '1234567890',
      b_stt: '',
      b_stt_cd: '',
      tax_type: '국세청에 등록되지 않은 사업자등록번호입니다.',
    };
    expect(mapStatus(item)).toEqual({ status: 'not_registered', raw: '' });
  });

  it('preserves unrecognized codes in raw while defaulting to not_registered', () => {
    expect(mapStatus({ b_no: '1234567890', b_stt_cd: '09' })).toEqual({ status: 'not_registered', raw: '09' });
  });
});

describe('mapTaxType', () => {
  it.each([
    ['01', 'general'],
    ['02', 'simplified'],
    ['03', 'simplified'],
    ['04', 'exempt'],
    ['05', 'non_profit'],
    ['06', 'non_profit'],
    ['07', 'simplified'],
    ['99', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('maps tax_type_cd %s to %s', (code, expected) => {
    expect(mapTaxType(code)).toBe(expected);
  });

  it('falls back to keywords in the Korean text when the code is unknown', () => {
    expect(mapTaxType(undefined, '부가가치세 일반과세자')).toBe('general');
    expect(mapTaxType(undefined, '부가가치세 간이과세자')).toBe('simplified');
    expect(mapTaxType(undefined, '부가가치세 면세사업자')).toBe('exempt');
    expect(mapTaxType(undefined, '고유번호가 부여된 단체')).toBe('non_profit');
    expect(mapTaxType(undefined, '국세청에 등록되지 않은 사업자등록번호입니다.')).toBe('unknown');
  });
});

describe('buildStatusResult', () => {
  const checkedAt = '2026-08-22T09:00:00.000Z';

  it('builds the full English schema for an active business', () => {
    const result = buildStatusResult(
      '1234567890',
      { b_no: '1234567890', b_stt_cd: '01', tax_type_cd: '01' },
      { cache: false, checkedAt },
    );
    expect(result).toEqual({
      business_number: '1234567890',
      status: 'active',
      status_code_raw: '01',
      tax_type: 'general',
      closed_date: null,
      checked_at: checkedAt,
      source: 'Korea National Tax Service (NTS)',
      cache: false,
    });
  });

  it('includes an ISO closed_date only for closed businesses', () => {
    const closed = buildStatusResult(
      '1234567890',
      { b_no: '1234567890', b_stt_cd: '03', tax_type_cd: '01', end_dt: '20230131' },
      { cache: false, checkedAt },
    );
    expect(closed.status).toBe('closed');
    expect(closed.closed_date).toBe('2023-01-31');

    const active = buildStatusResult(
      '1234567890',
      { b_no: '1234567890', b_stt_cd: '01', tax_type_cd: '01', end_dt: '20230131' },
      { cache: false, checkedAt },
    );
    expect(active.closed_date).toBeNull();
  });

  it('forces tax_type to unknown for unregistered numbers', () => {
    const result = buildStatusResult(
      '1234567890',
      { b_no: '1234567890', b_stt_cd: '', tax_type: '국세청에 등록되지 않은 사업자등록번호입니다.' },
      { cache: true, checkedAt },
    );
    expect(result.status).toBe('not_registered');
    expect(result.tax_type).toBe('unknown');
    expect(result.cache).toBe(true);
  });
});
