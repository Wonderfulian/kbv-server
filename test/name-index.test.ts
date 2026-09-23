/**
 * Name index tests: normalization, candidate ranking, DART parsing, and the
 * progressive-enrichment merge. No network — the DART client is faked.
 */

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { disambiguationNote, normalizeName, searchIndex, type NameIndexEntry } from '../src/name-index.js';
import { parseCorpCodes, unzipSingleFile } from '../src/dart.js';
import { enrich, mergeIndex, selectForEnrichment } from '../src/index-build-job.js';
import type { DartClient, DartCorp } from '../src/dart.js';

const samsung: NameIndexEntry = {
  business_number: '1248100998',
  name: '삼성전자(주)',
  name_en: 'SAMSUNG ELECTRONICS CO,.LTD',
  corp_code: '00126380',
  listed: true,
  source: 'dart',
};
const sales: NameIndexEntry = {
  name: '삼성전자판매',
  name_en: 'SAMSUNG ELECTRONICS SALES Co., Ltd.',
  corp_code: '00252074',
  listed: false,
  source: 'dart',
};
const vendor: NameIndexEntry = { business_number: '2208162517', name: '삼성전자우호기업', source: 'g2b' };

describe('normalizeName', () => {
  it('collapses legal forms, case, punctuation and spacing', () => {
    expect(normalizeName('SAMSUNG ELECTRONICS CO,.LTD')).toBe('samsungelectronics');
    expect(normalizeName('Samsung Electronics')).toBe('samsungelectronics');
    expect(normalizeName('삼성전자(주)')).toBe('삼성전자');
    expect(normalizeName('주식회사 삼성전자')).toBe('삼성전자');
  });

  it('is empty for a query with nothing but noise', () => {
    expect(normalizeName('  (주) ')).toBe('');
  });
});

describe('searchIndex', () => {
  const index = [samsung, sales, vendor];

  it('finds a company by its English name', () => {
    const [top] = searchIndex(index, 'Samsung Electronics');
    expect(top.entry.business_number).toBe('1248100998');
    expect(top.match).toEqual({ type: 'exact', field: 'name_en' });
    expect(top.confidence).toBeGreaterThan(0.9);
  });

  it('returns every plausible company, not one confident answer', () => {
    const results = searchIndex(index, '삼성전자');
    expect(results.length).toBeGreaterThan(1);
    expect(results.map((r) => r.entry.name)).toContain('삼성전자판매');
  });

  it('ranks the exact match above prefix and contains matches', () => {
    const results = searchIndex(index, '삼성전자');
    expect(results[0].entry.name).toBe('삼성전자(주)');
    expect(results[0].match.type).toBe('exact');
  });

  it('never invents a match for an unknown name', () => {
    expect(searchIndex(index, 'Hyundai Motor')).toEqual([]);
  });

  it('ignores a query that normalizes to nothing', () => {
    expect(searchIndex(index, '(주)')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(searchIndex(index, '삼성', { limit: 2 })).toHaveLength(2);
  });

  it('prefers a resolved business number when confidence ties', () => {
    const unresolved: NameIndexEntry = { name: '동일이름', source: 'dart', listed: false };
    const resolved: NameIndexEntry = { name: '동일이름', business_number: '1111111111', source: 'dart', listed: false };
    const [first] = searchIndex([unresolved, resolved], '동일이름');
    expect(first.entry.business_number).toBe('1111111111');
  });
});

describe('disambiguationNote', () => {
  it('warns when several candidates match equally well', () => {
    const a: NameIndexEntry = { name: '같은이름', source: 'dart' };
    const b: NameIndexEntry = { name: '같은이름', source: 'dart' };
    expect(disambiguationNote(searchIndex([a, b], '같은이름'))).toMatch(/distinct legal entities/);
  });

  it('stays silent for a single clear winner', () => {
    expect(disambiguationNote(searchIndex([samsung], 'Samsung Electronics'))).toBeUndefined();
  });
});

describe('DART parsing', () => {
  it('reads a deflated ZIP member', () => {
    const payload = Buffer.from('<result><list><corp_code>1</corp_code></list></result>', 'utf8');
    expect(unzipSingleFile(makeZip(payload)).toString('utf8')).toContain('corp_code');
  });

  it('keeps only identity fields from corpCode.xml', () => {
    const xml = `<result>
      <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name>
        <corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name><stock_code>005930</stock_code>
        <modify_date>20260101</modify_date></list>
      <list><corp_code>00252074</corp_code><corp_name>삼성전자판매</corp_name>
        <corp_eng_name></corp_eng_name><stock_code></stock_code><modify_date>20260101</modify_date></list>
    </result>`;
    const corps = parseCorpCodes(xml);
    expect(corps).toHaveLength(2);
    expect(corps[0]).toEqual({
      corp_code: '00126380',
      name: '삼성전자',
      name_en: 'SAMSUNG ELECTRONICS CO,.LTD',
      listed: true,
    });
    expect(corps[1].name_en).toBeUndefined();
    expect(corps[1].listed).toBe(false);
  });
});

describe('progressive enrichment', () => {
  const corps: DartCorp[] = [
    { corp_code: '00126380', name: '삼성전자', name_en: 'SAMSUNG ELECTRONICS CO,.LTD', listed: true },
    { corp_code: '00252074', name: '삼성전자판매', listed: false },
  ];

  it('carries resolved business numbers across rebuilds', () => {
    const existing: NameIndexEntry[] = [
      { corp_code: '00126380', name: '(구)삼성전자', business_number: '1248100998', source: 'dart' },
    ];
    const merged = mergeIndex(existing, corps);
    expect(merged.find((e) => e.corp_code === '00126380')).toMatchObject({
      name: '삼성전자', // identity follows upstream
      business_number: '1248100998', // rate-limited lookup is not repeated
    });
  });

  it('leaves entries from other sources alone', () => {
    const merged = mergeIndex([vendor], corps);
    expect(merged.filter((e) => e.source === 'g2b')).toEqual([vendor]);
  });

  it('spends the daily budget on listed companies first', () => {
    const merged = mergeIndex([], corps);
    const picked = selectForEnrichment(merged, 1);
    expect(picked).toHaveLength(1);
    expect(picked[0].corp_code).toBe('00126380');
  });

  it('records resolved, missing and failed separately', async () => {
    const targets: NameIndexEntry[] = [
      { corp_code: 'A', name: 'a', source: 'dart' },
      { corp_code: 'B', name: 'b', source: 'dart' },
      { corp_code: 'C', name: 'c', source: 'dart' },
    ];
    const dart = {
      async fetchCorpCodes() {
        return [];
      },
      async fetchBusinessNumber(code: string) {
        if (code === 'A') return '1234567890';
        if (code === 'B') return null;
        throw new Error('DART 020 rate limited');
      },
    } as DartClient;

    const result = await enrich(dart, targets, 2, () => {});
    expect(result).toEqual({ attempted: 3, resolved: 1, missing: 1, failed: 1 });
    expect(targets[0].business_number).toBe('1234567890');
    expect(targets[1].business_number).toBeUndefined();
  });
});

/** Minimal single-member ZIP, so the unzip path is tested without fixtures. */
function makeZip(content: Buffer): Buffer {
  const name = Buffer.from('CORPCODE.xml', 'utf8');
  const deflated = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localOffset = 0;

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(localOffset, 42);

  const centralOffset = local.length + name.length + deflated.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, deflated, central, name, eocd]);
}
