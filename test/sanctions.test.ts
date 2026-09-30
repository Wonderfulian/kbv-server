/**
 * Debarment screening. The contract worth pinning is the three-way
 * distinction an agent cannot infer: field absent (not checked), empty array
 * (screened, clear), and a record with `active` telling a live debarment from
 * an expired one.
 */

import { describe, expect, it } from 'vitest';
import { createCache } from '../src/cache.js';
import type { NtsClient } from '../src/nts.js';
import { createSanctionsLookup, indexSanctions, isActiveOn, type SanctionRecord } from '../src/sanctions.js';
import { checkStatusBatch, type BatchResult, type Deps } from '../src/service.js';

const BARRED = '3278100184';
const CLEAN = '1248100998';

const record: SanctionRecord = {
  business_number: BARRED,
  name: '주식회사 세연인터내셔널',
  begins_on: '2026-02-26',
  ends_on: '2026-11-25',
  institution: '방위사업청',
  law: '국가계약법-부정당제재근거법령 법27조제1항9호',
  status: '처분확정',
};
const expired: SanctionRecord = { ...record, begins_on: '2020-01-01', ends_on: '2020-12-31' };

const nts: NtsClient = {
  async checkStatus(bNos) {
    return bNos.map((b) => ({ b_no: b, b_stt_cd: '01', tax_type_cd: '01' }));
  },
  async validate() {
    return [];
  },
};

function deps(extra: Partial<Deps> = {}): Deps {
  return { nts, cache: createCache(), ...extra };
}

describe('isActiveOn', () => {
  it('is true inside the window and false outside it', () => {
    expect(isActiveOn(record, '2026-06-01')).toBe(true);
    expect(isActiveOn(record, '2026-02-26')).toBe(true); // inclusive start
    expect(isActiveOn(record, '2026-11-25')).toBe(true); // inclusive end
    expect(isActiveOn(record, '2026-01-01')).toBe(false);
    expect(isActiveOn(record, '2026-12-01')).toBe(false);
  });

  it('treats a missing bound as open-ended', () => {
    expect(isActiveOn({ business_number: BARRED, name: 'x' }, '2026-06-01')).toBe(true);
    expect(isActiveOn({ business_number: BARRED, name: 'x', begins_on: '2030-01-01' }, '2026-06-01')).toBe(false);
  });
});

describe('indexSanctions', () => {
  it('groups by company, newest window first', () => {
    const index = indexSanctions([expired, record]);
    expect(index.get(BARRED)?.map((r) => r.begins_on)).toEqual(['2026-02-26', '2020-01-01']);
  });
});

describe('batch screening', () => {
  const lookup = createSanctionsLookup(
    async () => ({ updated_at: '2026-09-28T00:00:00Z', sanctions: [record, expired] }),
    () => new Date('2026-06-01T00:00:00Z'),
  );

  it('attaches debarments and counts the currently barred', async () => {
    const out = await checkStatusBatch(deps({ sanctions: lookup }), [BARRED, CLEAN]);
    const result = (out as { result: BatchResult }).result;

    const barred = result.results.find((r) => r.business_number === BARRED);
    expect(barred?.status).toBe('active'); // active *and* barred — the point
    expect(barred?.sanctions).toHaveLength(2);
    expect(barred?.sanctions?.[0]).toMatchObject({ institution: '방위사업청', status: '처분확정', active: true });
    expect(barred?.sanctions?.[1].active).toBe(false); // the 2020 window expired
    expect(result.summary.sanctioned).toBe(1);
  });

  it('says "screened, clear" with an empty array, not a missing field', async () => {
    const out = await checkStatusBatch(deps({ sanctions: lookup }), [CLEAN]);
    const result = (out as { result: BatchResult }).result;
    expect(result.results[0].sanctions).toEqual([]);
    expect(result.summary.sanctioned).toBe(0);
  });

  it('omits the field entirely when the server has no debarment data', async () => {
    const out = await checkStatusBatch(deps(), [BARRED]);
    const result = (out as { result: BatchResult }).result;
    expect(result.results[0].sanctions).toBeUndefined();
    expect(result.summary.sanctioned).toBeUndefined();
  });

  it('keeps the status answers when the debarment lookup fails', async () => {
    const broken = createSanctionsLookup(async () => {
      throw new Error('bucket unreachable');
    });
    const out = await checkStatusBatch(deps({ sanctions: broken }), [BARRED, CLEAN]);
    const result = (out as { result: BatchResult }).result;
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('active');
    expect(result.results[0].sanctions).toBeUndefined(); // reads as "not checked"
    expect(result.summary.total).toBe(2);
  });

  it('loads the file once across calls', async () => {
    let loads = 0;
    const counted = createSanctionsLookup(async () => {
      loads++;
      return { updated_at: 'x', sanctions: [record] };
    });
    await checkStatusBatch(deps({ sanctions: counted }), [BARRED]);
    await checkStatusBatch(deps({ sanctions: counted }), [CLEAN]);
    expect(loads).toBe(1);
  });
});
