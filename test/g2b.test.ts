/**
 * Procurement-registry collector tests. No network: the client is faked, and
 * the field-minimization tests are the ones that matter — the upstream hands
 * us a representative's name and a street address on every row.
 */

import { describe, expect, it } from 'vitest';
import { createG2bClient, monthWindows, toVendor, truncateRegion, type G2bVendor } from '../src/g2b.js';
import { collectVendors, dedupeVendors, mergeVendorsIntoIndex, parseMonth, toCorpus } from '../src/g2b-collect-job.js';
import type { NameIndexEntry } from '../src/name-index.js';
import type { CorpusEntry } from '../src/snapshot.js';

const RAW = {
  bizno: '1248100998',
  corpNm: '삼성전자',
  engCorpNm: 'SAMSUNG ELECTRONICS',
  rgnNm: '경기도 수원시 영통구 매탄동',
  ceoNm: '홍길동',
  telNo: '031-000-0000',
  adrs: '삼성로 129',
};

describe('field minimization', () => {
  it('keeps identity only — no representative name, no street address', () => {
    const vendor = toVendor(RAW) as G2bVendor;
    expect(vendor).toEqual({
      business_number: '1248100998',
      name: '삼성전자',
      name_en: 'SAMSUNG ELECTRONICS',
      region: '경기도 수원시',
    });
    expect(JSON.stringify(vendor)).not.toContain('홍길동');
    expect(JSON.stringify(vendor)).not.toContain('031-');
  });

  it('truncates an address to city and district', () => {
    expect(truncateRegion('경기도 남양주시 오남읍 양지리')).toBe('경기도 남양주시');
    expect(truncateRegion('서울특별시 강남구 테헤란로 1길 2')).toBe('서울특별시 강남구');
    expect(truncateRegion(undefined)).toBeUndefined();
  });

  it('rejects rows without a usable number or name', () => {
    expect(toVendor({ bizno: '123', corpNm: '짧은번호' })).toBeNull();
    expect(toVendor({ bizno: '1248100998', corpNm: '   ' })).toBeNull();
  });
});

describe('monthWindows', () => {
  it('emits 12-digit windows, newest first', () => {
    const windows = monthWindows(new Date('2026-07-01T00:00:00Z'), new Date('2026-09-15T00:00:00Z'));
    expect(windows.map((w) => w.label)).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(windows[0]).toMatchObject({ from: '202609010000', to: '202609302359' });
  });

  it('handles a February and a year boundary', () => {
    const windows = monthWindows(new Date('2023-12-01T00:00:00Z'), new Date('2024-02-01T00:00:00Z'));
    expect(windows.map((w) => w.to)).toEqual(['202402292359', '202401312359', '202312312359']);
  });

  it('parses YYYY-MM and rejects anything else', () => {
    expect(parseMonth('2026-01').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(() => parseMonth('2026/01')).toThrow(/YYYY-MM/);
  });
});

describe('client', () => {
  it('surfaces the non-standard error envelope instead of reporting zero rows', async () => {
    const client = createG2bClient({
      serviceKey: 'x',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ 'nkoneps.com.response.ResponseError': { header: { resultCode: '06', resultMsg: 'DATE Format 에러' } } }),
        )) as unknown as typeof fetch,
    });
    await expect(client.fetchMonth({ from: '202609010000', to: '202609302359' })).rejects.toThrow(/DATE Format/);
  });

  it('pages until a short page arrives', async () => {
    const pages: string[] = [];
    const client = createG2bClient({
      serviceKey: 'x',
      pageSize: 2,
      fetchImpl: (async (url: URL) => {
        const page = url.searchParams.get('pageNo') as string;
        pages.push(page);
        const items = page === '1' ? [RAW, { ...RAW, bizno: '2208162517' }] : [{ ...RAW, bizno: '1234567890' }];
        return new Response(JSON.stringify({ response: { body: { items } } }));
      }) as unknown as typeof fetch,
    });
    const rows = await client.fetchMonth({ from: '202609010000', to: '202609302359' });
    expect(pages).toEqual(['1', '2']);
    expect(rows).toHaveLength(3);
  });
});

describe('collectVendors', () => {
  const vendors: G2bVendor[] = [
    { business_number: '1248100998', name: '삼성전자', region: '경기도 수원시' },
    { business_number: '2208162517', name: '두번째업체' },
  ];

  function fakeClient(byMonth: Record<string, G2bVendor[]>, fail: string[] = []) {
    return {
      async fetchMonth(w: { from: string }) {
        const label = `${w.from.slice(0, 4)}-${w.from.slice(4, 6)}`;
        if (fail.includes(label)) throw new Error('upstream 503');
        return byMonth[label] ?? [];
      },
    };
  }

  function stores() {
    const index: NameIndexEntry[] = [{ corp_code: '00126380', name: '삼성전자', source: 'dart' }];
    const corpus: CorpusEntry[] = [{ business_number: '9999999999', corpus_source: 'g2b_sanctions' }];
    return {
      index,
      corpus,
      indexStore: {
        async read() {
          return index;
        },
        async write(entries: NameIndexEntry[]) {
          index.length = 0;
          index.push(...entries);
        },
      },
      snapshotStore: {
        async readCorpus() {
          return corpus;
        },
        async writeCorpus(entries: CorpusEntry[]) {
          corpus.length = 0;
          corpus.push(...entries);
        },
      },
    };
  }

  it('writes the index slice and the corpus, keeping other sources', async () => {
    const s = stores();
    const summary = await collectVendors({
      g2b: fakeClient({ '2026-09': vendors }),
      indexStore: s.indexStore,
      snapshotStore: s.snapshotStore,
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });

    expect(summary).toMatchObject({ unique_vendors: 2, months: 1, failed_months: 0 });
    expect(s.index.filter((e) => e.source === 'dart')).toHaveLength(1); // DART slice untouched
    expect(s.index.filter((e) => e.source === 'g2b')).toHaveLength(2);
    // The sanctions corpus entry survives; vendors are added alongside it.
    expect(s.corpus.filter((c) => c.corpus_source === 'g2b_sanctions')).toHaveLength(1);
    expect(s.corpus.filter((c) => c.corpus_source === 'g2b_vendors')).toHaveLength(2);
  });

  it('keeps the months it did collect when one fails', async () => {
    const s = stores();
    const summary = await collectVendors({
      g2b: fakeClient({ '2026-09': vendors }, ['2026-08']),
      indexStore: s.indexStore,
      snapshotStore: s.snapshotStore,
      from: new Date('2026-08-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    expect(summary).toMatchObject({ failed_months: 1, unique_vendors: 2 });
  });

  it('deduplicates a vendor seen in several months, newest first', () => {
    const newest: G2bVendor = { business_number: '1248100998', name: '새이름' };
    const older: G2bVendor = { business_number: '1248100998', name: '옛이름' };
    expect(dedupeVendors([newest, older])).toEqual([newest]);
  });

  it('replaces only the g2b slice on rebuild', () => {
    const existing: NameIndexEntry[] = [
      { name: 'DART사', source: 'dart' },
      { name: '옛업체', business_number: '1111111111', source: 'g2b' },
    ];
    const merged = mergeVendorsIntoIndex(existing, vendors);
    expect(merged.filter((e) => e.source === 'g2b').map((e) => e.name)).toEqual(['삼성전자', '두번째업체']);
    expect(merged.filter((e) => e.source === 'dart')).toHaveLength(1);
  });

  it('labels corpus entries as a published list', () => {
    expect(toCorpus(vendors).every((c) => c.corpus_source === 'g2b_vendors')).toBe(true);
  });
});
