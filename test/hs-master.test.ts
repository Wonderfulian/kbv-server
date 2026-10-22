/**
 * HS code master + validation (TRADE-DESK stage 1).
 *
 * The property that matters most: an unknown code is refused BEFORE the x402
 * payment middleware. The upstream answers a nonexistent code with the same
 * empty "no requirements" it gives a real product, so a typo must never reach
 * it — and a caller must never be charged for one. The app tests below run
 * the real paymentMiddleware with a facilitator that counts verify/settle.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import type { FacilitatorClient } from '@x402/core/server';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type X402Options } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { buildHsMasterFile, HsMaster, HsMasterError, type HsMasterFile } from '../src/hs-master.js';
import { IMPORT_REQUIREMENTS_PATH } from '../src/hs-guard.js';
import type { NtsClient } from '../src/nts.js';
import type { Deps } from '../src/service.js';
import { readFirstSheet } from '../src/xlsx.js';

// --- fixtures ----------------------------------------------------------------

/** Excel serial for an ISO date (1900 system). */
const serial = (iso: string) => String(Math.round((Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86_400_000));

const HEADER = ['HS부호', '적용시작일자', '적용종료일자', '한글품목명', '영문품목명', 'HS부호내용'];
const ROWS = [
  HEADER,
  ['19059010', serial('2016-01-01'), serial('2026-12-31'), '베이커리 제품', "Bakers' wares", ''],
  ['1905901010', serial('2012-01-01'), serial('2026-12-31'), '빵', 'Bread', ''],
  ['1905901040', serial('2013-01-01'), serial('2026-12-31'), '비스킷, 쿠키와 크래커', 'Biscuits, cookies and crackers', ''],
  ['1905909000', serial('2002-01-01'), serial('2026-12-31'), '기타', 'Other', ''],
  ['7318152000', serial('2013-01-01'), serial('2026-12-31'), '볼트(bolt)', 'Bolts', ''],
  ['8516710000', serial('2013-01-01'), serial('2026-12-31'), '커피ㆍ차를 끓이는 기기', 'Coffee or tea makers', ''],
  // Repealed mid-edition: ends before the edition's blanket end date.
  ['8516719000', serial('2013-01-01'), serial('2026-06-30'), '폐지된 코드', 'Repealed code', ''],
  // Not yet in force.
  ['8516720000', serial('2026-11-01'), serial('2026-12-31'), '토스터', 'Toasters', ''],
];

const META = { source: 'test', dataset: '15049722', file_name: '관세청_HS부호_20260101', fetched_at: '2026-10-20T00:00:00Z' };
const master = () => new HsMaster(buildHsMasterFile(ROWS, META, 1));

/** Smallest valid XLSX: shared strings + one sheet, deflated like the real file. */
function makeXlsx(rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheetRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">` +
        r
          .map((v, ci) => {
            const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
            if (v === '') return '';
            return /^\d+$/.test(v) && ci > 0 ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${idx(v)}</v></c>`;
          })
          .join('') +
        '</row>',
    )
    .join('');
  const files: [string, string][] = [
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`],
    ['xl/sharedStrings.xml', `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = deflateRawSync(Buffer.from(text, 'utf8'));
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// --- XLSX + build ---------------------------------------------------------------

describe('XLSX reader + master build', () => {
  it('reads shared strings and numeric cells back into rows', () => {
    const rows = readFirstSheet(makeXlsx(ROWS));
    expect(rows[0]).toEqual(HEADER);
    expect(rows[6]).toEqual(ROWS[6].slice(0, 5)); // trailing empty cell is not emitted
  });

  it('builds codes keyed by header name, with ISO validity dates', () => {
    const file = buildHsMasterFile(readFirstSheet(makeXlsx(ROWS)), META, 1);
    expect(file.codes['8516710000']).toEqual(['커피ㆍ차를 끓이는 기기', 'Coffee or tea makers', '2013-01-01', '2026-12-31']);
    expect(file.codes['19059010']).toBeDefined(); // grouping rows are kept for candidate context
    expect(file.file_name).toBe('관세청_HS부호_20260101');
  });

  it('fails loudly when a column is missing or the file is too small', () => {
    expect(() => buildHsMasterFile([['HS부호', '한글품목명'], ['8516710000', 'x']], META, 1)).toThrow(HsMasterError);
    expect(() => buildHsMasterFile(ROWS, META, 10_000)).toThrow(/only 7 10-digit codes/);
  });
});

// --- lookup rules ----------------------------------------------------------------

describe('HsMaster.lookup', () => {
  const today = '2026-10-20';

  it('accepts a current 10-digit code, with separators', () => {
    for (const input of ['8516710000', '8516.71-0000', '8516 71 0000']) {
      expect(master().lookup(input, today)).toMatchObject({ kind: 'valid', hs_code: '8516710000', name_en: 'Coffee or tea makers' });
    }
  });

  it('refuses codes that do not exist — the case the upstream cannot tell from "no requirements"', () => {
    expect(master().lookup('9999999999', today)).toEqual({ kind: 'not_found', hs_code: '9999999999' });
  });

  it('refuses 4- and 8-digit input as not found (not a lookup-able code)', () => {
    expect(master().lookup('8516', today).kind).toBe('not_found');
    expect(master().lookup('19059010', today).kind).toBe('not_found');
  });

  it('answers 6 digits with every current 10-digit code under it, never a single guess', () => {
    const r = master().lookup('190590', today);
    expect(r.kind).toBe('candidates');
    if (r.kind !== 'candidates') return;
    expect(r.candidates.map((c) => c.hs_code)).toEqual(['1905901010', '1905901040', '1905909000']);
    // "Other" alone is useless; the nearest grouping row gives it context.
    expect(r.candidates[0]).toMatchObject({ name_en: 'Bread', group_en: "Bakers' wares" });
  });

  it('treats a 6-digit prefix with no codes as not found', () => {
    expect(master().lookup('999999', today).kind).toBe('not_found');
  });

  it('rejects non-digits as invalid input', () => {
    expect(master().lookup('8516A10000', today).kind).toBe('invalid_input');
    expect(master().lookup(undefined, today).kind).toBe('invalid_input');
  });

  it('refuses a code repealed mid-edition and one not yet in force', () => {
    expect(master().lookup('8516719000', today).kind).toBe('not_found');
    expect(master().lookup('8516720000', today).kind).toBe('not_found');
    expect(master().lookup('8516720000', '2026-11-01').kind).toBe('valid');
  });

  it('keeps working past the edition end date instead of rejecting every code on 1 January', () => {
    const m = master();
    expect(m.editionEnd).toBe('2026-12-31');
    expect(m.lookup('8516710000', '2027-01-02').kind).toBe('valid');
    expect(m.isStale('2027-01-02')).toBe(true);
    expect(m.isStale('2026-12-31')).toBe(false);
  });
});

// --- validation before payment (real x402 middleware) ------------------------------

describe('HS validation runs before the payment middleware', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  function countingFacilitator() {
    const calls = { verify: 0, settle: 0 };
    const client = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }, { x402Version: 2, scheme: 'upto', network: 'eip155:84532' }] };
      },
      async verify() {
        calls.verify++;
        return { isValid: false, invalidReason: 'test' };
      },
      async settle() {
        calls.settle++;
        return { success: false, errorReason: 'test' };
      },
    } as unknown as FacilitatorClient;
    return { calls, client };
  }

  async function start(opts: { tradeDesk: boolean; loadMaster?: () => Promise<HsMaster> }) {
    const fac = countingFacilitator();
    const x402: X402Options = {
      payTo: '0x0000000000000000000000000000000000000001',
      facilitatorUrl: 'http://127.0.0.1:1',
      network: 'eip155:84532',
      dailyFreeTier: 10,
      facilitatorClient: fac.client,
      tradeDesk: opts.tradeDesk,
    };
    const upstream = { calls: 0 };
    const nts = {
      async checkStatus() {
        upstream.calls++;
        return [];
      },
      async validate() {
        upstream.calls++;
        return [];
      },
    } as unknown as NtsClient;
    const outcomes: string[] = [];
    const deps: Deps = {
      nts,
      cache: createCache(),
      hsMaster: opts.loadMaster ?? (async () => master()),
      hsLog: (i) => outcomes.push(i.outcome),
    };
    server = buildApp(deps, x402).listen(0);
    await new Promise<void>((r) => server!.once('listening', r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    // A payment header on every request: if validation ran after the payment
    // middleware, the middleware would try to verify it.
    const get = (q: string) =>
      fetch(`${base}${IMPORT_REQUIREMENTS_PATH}?${q}`, { headers: { 'payment-signature': Buffer.from('{"x402Version":2}').toString('base64') } });
    return { get, base, calls: fac.calls, upstream, outcomes };
  }

  it('refuses 9999999999 and a 4-digit code with 400 hs_code_not_found — no 402, no verify, no settle', async () => {
    const t = await start({ tradeDesk: true });
    for (const q of ['hs_code=9999999999', 'hs_code=8516']) {
      const res = await t.get(q);
      expect(res.status).toBe(400);
      expect(res.headers.get('payment-required')).toBeNull();
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('hs_code_not_found');
      expect(body.message).toMatch(/nothing was charged/i);
    }
    expect(t.calls).toEqual({ verify: 0, settle: 0 });
    expect(t.upstream.calls).toBe(0);
    expect(t.outcomes).toEqual(['hs_code_not_found', 'hs_code_not_found']);
  });

  it('answers 6 digits with candidates for free', async () => {
    const t = await start({ tradeDesk: true });
    const res = await t.get('hs_code=190590');
    expect(res.status).toBe(400);
    expect(res.headers.get('payment-required')).toBeNull();
    const body = (await res.json()) as { error: string; candidates: { hs_code: string }[] };
    expect(body.error).toBe('hs_code_incomplete');
    expect(body.candidates).toHaveLength(3);
    expect(t.calls).toEqual({ verify: 0, settle: 0 });
  });

  it('lets a valid code through to the payment middleware (402 without payment)', async () => {
    const t = await start({ tradeDesk: true });
    const res = await fetch(`${t.base}${IMPORT_REQUIREMENTS_PATH}?hs_code=7318152000`);
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
    expect(t.outcomes).toEqual(['ok']);
  });

  it('never asks for payment for the documented test code', async () => {
    const t = await start({ tradeDesk: true });
    const res = await fetch(`${t.base}${IMPORT_REQUIREMENTS_PATH}?hs_code=8516.71-0000`);
    expect(res.status).not.toBe(402);
    expect(t.calls).toEqual({ verify: 0, settle: 0 });
  });

  it('rejects a bad direction before payment', async () => {
    const t = await start({ tradeDesk: true });
    const res = await fetch(`${t.base}${IMPORT_REQUIREMENTS_PATH}?hs_code=7318152000&direction=sideways`);
    expect(res.status).toBe(400);
    expect(res.headers.get('payment-required')).toBeNull();
  });

  it('fails closed with 503 when the master cannot be loaded — never "no requirements", never charged', async () => {
    const t = await start({ tradeDesk: true, loadMaster: async () => Promise.reject(new Error('gcs down')) });
    const res = await t.get('hs_code=8516710000');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('hs_master_unavailable');
    expect(t.calls).toEqual({ verify: 0, settle: 0 });
  });

  it('keeps the route unpriced and out of discovery while the stage flag is off', async () => {
    const t = await start({ tradeDesk: false });
    const res = await fetch(`${t.base}${IMPORT_REQUIREMENTS_PATH}?hs_code=8516710000`);
    expect(res.status).toBe(404); // no handler yet, and no 402 for it
    const manifest = (await (await fetch(`${t.base}/.well-known/x402`)).json()) as { resources: { url: string }[] };
    expect(manifest.resources.some((r) => r.url.includes('korea-import'))).toBe(false);
    // Validation still applies with the flag off.
    expect((await t.get('hs_code=9999999999')).status).toBe(400);
  });

  it('lists the route at $0.03 in discovery once the flag is on', async () => {
    const t = await start({ tradeDesk: true });
    const manifest = (await (await fetch(`${t.base}/.well-known/x402`)).json()) as {
      resources: { url: string; accepts: { price: string }[] }[];
    };
    const route = manifest.resources.find((r) => r.url.includes('/v1/korea-import/requirements'));
    expect(route?.accepts[0].price).toBe('$0.03');
  });
});

// Keep the fixture honest about its own shape.
const _typecheck: HsMasterFile['codes'] = buildHsMasterFile(ROWS, META, 1).codes;
void _typecheck;
