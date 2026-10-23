/**
 * Import/export requirements (TRADE-DESK stage 4). Fixtures are the real
 * upstream rows for the coffee maker (8516710000): seven rows, three
 * statutes, five alternative agencies under the electrical-products act.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FacilitatorClient } from '@x402/core/server';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type X402Options } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { createCustomsClient, CustomsError, parseRequirements, type CustomsClient, type CustomsRequirementRow } from '../src/customs.js';
import { ConditionsIndex, indexConditionRows, type ConditionsFile } from '../src/hs-conditions.js';
import { IMPORT_REQUIREMENTS_PATH } from '../src/hs-guard.js';
import { buildHsMasterFile, HsMaster } from '../src/hs-master.js';
import { importRequirements, TEST_HS_CODE, type TradeDeps } from '../src/import-requirements.js';
import { buildMcpServer } from '../src/mcp.js';
import type { NtsClient } from '../src/nts.js';
import type { Deps } from '../src/service.js';
import { buildTariffFile, TariffIndex } from '../src/tariff.js';
import { resolveStatute, type DictMiss } from '../src/trade-dict.js';

const row = (aply: string, statuteCode: string, statuteName: string, agencyCode: string, agencyName: string, certificateName: string): CustomsRequirementRow => ({
  aplyStrtDt: aply,
  statuteCode,
  statuteName,
  agencyCode,
  agencyName,
  certificateName,
});
const KC = '전기용품 및 생활용품 안전관리법';
const KC_DOC = '전기용품 및 생활용품 요건확인서';
const COFFEE: CustomsRequirementRow[] = [
  row('20200406', '23', KC, '105', '기술표준원', KC_DOC),
  row('20200406', '23', KC, '314', '한국산업기술시험원', KC_DOC),
  row('20200406', '23', KC, '257', '한국화학융합시험연구원', KC_DOC),
  row('20200406', '23', KC, '336', '한국제품안전협회', KC_DOC),
  row('20200406', '39', '전파법', '108', '국립전파연구원', '방송통신기기인증확인서'),
  row('20200406', '23', KC, '315', '한국기계전기전자시험연구원', KC_DOC),
  row('20200406', '89', '수입식품안전관리 특별법', '005', '식품의약품안전처', '수입식품등 수입신고확인증'),
];
const KC_TEXT =
  '[전기용품 및 생활용품 안전관리법]\n. 정격전압이 30V초과 1000V이하의 교류전원 … (다만, 정격입력이 10KW이하인 것에 한함)';

const conditionsFile = (): ConditionsFile => {
  const { map } = indexConditionRows([
    ['【별표 2의2】 …', '', '', ''],
    ['품목번호', '품  명', '수   입    요   건  ', '관계법령'],
    ['8516.71-0000', '커피메이커', `${KC_TEXT.replace(/\n/g, '\r\n')}`, KC],
  ]);
  return {
    notice: { name_ko: '관세법 제226조에 따른 세관장확인물품 및 확인방법 지정고시', notice_no: '제2026-46호', effective_from: '2026-07-16', serial: '2100000282502', url: 'x' },
    built_at: '2026-10-22T00:00:00Z',
    files: { import: 'a.xlsx', export: 'b.xlsx' },
    import: map,
    export: {},
    unresolved: { import: 0, export: 0, samples: [] },
  };
};

const tariffIndex = () =>
  new TariffIndex(
    buildTariffFile(
      [
        ['품목번호', '관세율구분', '관세율', '단위당세액', '기준가격', '적용국가구분', '용도세율구분', '적용개시일', '적용만료일'],
        ['8516710000', 'A', '8', '', '', '1', '', '20260101', '20261231'],
        ['8516710000', 'FUS1', '0', '', '', '2', '', '20260101', '20261231'],
        ['8516710000', 'FEU1', '0', '', '', '2', '', '20260101', '20260630'],
        ['7318152000', 'A', '8', '', '', '1', '', '20260101', '20261231'],
      ],
      { source: 't', dataset: '15051179', file_name: '관세청_품목번호별 관세율표_20260211', fetched_at: 'x', next_edition_due: '2027-01-31' },
      1,
    ),
  );

function tradeDeps(rows: Record<string, CustomsRequirementRow[] | Error>, extra: Partial<TradeDeps> = {}): TradeDeps & { misses: DictMiss[]; customsCalls: string[] } {
  const misses: DictMiss[] = [];
  const customsCalls: string[] = [];
  const customs: CustomsClient = {
    async requirements(hs, direction) {
      customsCalls.push(`${hs}:${direction}`);
      const r = rows[hs] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return {
    customs,
    conditions: async () => new ConditionsIndex(conditionsFile()),
    tariff: async () => tariffIndex(),
    today: () => '2026-10-22',
    now: () => new Date('2026-10-22T00:00:00Z'),
    onDictMiss: (m) => misses.push(m),
    misses,
    customsCalls,
    ...extra,
  };
}

const COFFEE_HS = { hs_code: '8516710000', name_ko: '커피ㆍ차를 끓이는 기기', name_en: 'Coffee or tea makers' };
const BOLT_HS = { hs_code: '7318152000', name_ko: '볼트(bolt)', name_en: 'Bolts' };

describe('importRequirements (service)', () => {
  it('groups rows into statute + certificate requirements, agencies as alternatives', async () => {
    const out = await importRequirements(tradeDeps({ '8516710000': COFFEE }), COFFEE_HS, 'import', { full: true });
    expect(out.status).toBe(200);
    expect(out.body.requirement_count).toBe(3); // not 7
    const reqs = out.body.requirements as Record<string, unknown>[];
    const kc = reqs.find((r) => r.statute_code === '23')!;
    expect((kc.approving_agencies as { code: string }[]).map((a) => a.code)).toEqual(['105', '314', '257', '336', '315']);
    expect(kc.agencies_note).toMatch(/Any one of the listed agencies/);
    expect(kc.statute_name_en).toBe('Electrical Appliances and Consumer Products Safety Control Act');
    expect(kc.certificate_name_en).toBeNull();
    expect(kc.certificate_name_en_unofficial).toBe('Requirement confirmation for electrical appliances and consumer products');
    expect(kc.effective_from).toBe('2020-04-06');
  });

  it('quotes the condition verbatim with its granularity, source and the Korean-is-authoritative note', async () => {
    const out = await importRequirements(tradeDeps({ '8516710000': COFFEE }), COFFEE_HS, 'import', { full: true });
    const kc = (out.body.requirements as Record<string, unknown>[]).find((r) => r.statute_code === '23')!;
    const cond = kc.condition as Record<string, unknown>;
    expect(cond.text_ko).toBe(KC_TEXT);
    expect(cond.granularity).toBe('hs10');
    expect(cond.text_en_unofficial).toBeNull();
    expect(cond.note).toMatch(/^The condition is quoted in Korean exactly as published. We do not supply a translation/);
    expect(cond.source).toMatchObject({ notice_no: '제2026-46호', effective_from: '2026-07-16' });
    expect(out.body.attribution).toBe('Source: Ministry of Government Legislation (법제처), law.go.kr');
    // A statute with neither an HS-level row nor a statute row says so instead of pretending.
    const radio = (out.body.requirements as Record<string, unknown>[]).find((r) => r.statute_code === '39')!;
    expect(radio.condition).toBeNull();
    expect(radio.condition_note).toMatch(/Neither the notice's HS-level attachment nor its body has a condition/);
  });

  it("falls back to the statute's row in the notice body, and says it is coarser", async () => {
    const items = [
      { scope_ko: '(33)「전파법」해당 물품', documents_ko: '' },
      { scope_ko: '  (가)적합성평가대상 또는 적합성평가시험 신청\n기자재', documents_ko: 'ㅇ국립전파연구원장의 적합성 평가확인 또는\n사전통관확인서' },
    ];
    const file = { ...conditionsFile(), statute_groups: { import: { '001732': { items } }, export: {}, unresolved: [] } };
    const deps = tradeDeps({ '8516710000': COFFEE }, { conditions: async () => new ConditionsIndex(file) });
    const out = await importRequirements(deps, COFFEE_HS, 'import', { full: true });
    const reqs = out.body.requirements as Record<string, unknown>[];
    const radio = reqs.find((r) => r.statute_code === '39')!;
    const cond = radio.condition as Record<string, unknown>;
    expect(cond.granularity).toBe('statute_group');
    expect(cond.items_ko).toEqual(items);
    expect(cond.text_en_unofficial).toBeNull();
    expect(cond.granularity_note).toMatch(/covers every item under the statute, not this code alone/);
    expect(cond.source).toMatchObject({ part: '별표 2 세관장확인대상 수입물품 (고시 본문)', notice_no: '제2026-46호' });
    expect(radio).not.toHaveProperty('condition_note');
    // The HS-level row still wins where it exists.
    expect((reqs.find((r) => r.statute_code === '23')!.condition as Record<string, unknown>).granularity).toBe('hs10');
    expect(out.body.attribution).toMatch(/law\.go\.kr/);
  });

  it('never decides whether a condition applies', async () => {
    const out = await importRequirements(tradeDeps({ '8516710000': COFFEE }), COFFEE_HS, 'import', { full: true });
    expect(JSON.stringify(out.body)).not.toMatch(/"applies"\s*:|"applicable"\s*:|"meets"\s*:/);
    expect(out.body.disclaimer).toMatch(/does not decide whether a\s+condition applies/);
  });

  it('answers a valid code with no requirements definitively', async () => {
    const out = await importRequirements(tradeDeps({}), BOLT_HS, 'import', { full: true });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ hs_code_valid: true, requirements_checked: true, has_requirements: false, requirement_count: 0, requirements: [] });
    expect(out.body.requirements_note).toMatch(/definitive result for a valid code/);
    expect(out.body.attribution).toBeUndefined();
  });

  it('turns an upstream failure into 503 with requirements_checked:false — never "no requirements" — and keeps item and tariff', async () => {
    const out = await importRequirements(tradeDeps({ '8516710000': new CustomsError('down') }), COFFEE_HS, 'import', { full: true });
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ error: 'upstream_unavailable', requirements_checked: false, item_name_en: 'Coffee or tea makers' });
    expect(out.body.requirements).toBeUndefined();
    expect((out.body.tariff as Record<string, unknown>).rates).toBeTruthy();
  });

  it('still returns requirements when the condition and tariff indexes are unavailable', async () => {
    const deps = tradeDeps({ '8516710000': COFFEE }, { conditions: async () => Promise.reject(new Error('x')), tariff: async () => Promise.reject(new Error('x')) });
    const out = await importRequirements(deps, COFFEE_HS, 'import', { full: true });
    expect(out.status).toBe(200);
    expect(out.body.requirement_count).toBe(3);
    expect(out.body.tariff).toBeNull();
    const kc = (out.body.requirements as Record<string, unknown>[])[0];
    expect(kc.condition_note).toMatch(/condition index is unavailable/);
  });

  it('stamps the tariff with its source date, names only A and C, and reports source gaps apart from "no rate"', async () => {
    const out = await importRequirements(tradeDeps({ '8516710000': COFFEE }), COFFEE_HS, 'import', { full: false });
    const t = out.body.tariff as Record<string, unknown>;
    expect(t).toMatchObject({ source_as_of: '2026-02-11', next_edition_due: '2027-01-31', stale: false });
    const rates = t.rates as Record<string, unknown>[];
    expect(rates.find((r) => r.type === 'A')).toMatchObject({ type_meaning: 'Basic rate (기본세율)', rate: '8' });
    expect(rates.find((r) => r.type === 'FUS1')).not.toHaveProperty('type_meaning');
    expect(t).toMatchObject({ source_dataset_url: 'https://www.data.go.kr/data/15051179/fileData.do' });
    expect(JSON.stringify(t)).not.toMatch(/unipass/i);
    expect(t.coverage_gaps).toEqual([{ type: 'FEU1', last_rate: '0', ended_on: '2026-06-30' }]);
    expect(t.coverage_gaps_note).toMatch(/not that no such rate exists/);
  });

  it('gives the free tier a summary only', async () => {
    const out = await importRequirements(tradeDeps({ '8516710000': COFFEE }), COFFEE_HS, 'import', { full: false });
    expect(out.body).toMatchObject({ has_requirements: true, requirement_count: 3, detail: 'summary' });
    expect(out.body.requirements).toBeUndefined();
  });

  it('gives no tariff for exports', async () => {
    const out = await importRequirements(tradeDeps({}), BOLT_HS, 'export', { full: true });
    expect(out.body.tariff).toBeNull();
    expect(out.body.tariff_note).toMatch(/not given for exports/);
  });

  it('reports dictionary misses once per request', async () => {
    const deps = tradeDeps({ '8516710000': [...COFFEE, row('20200406', '23', KC, '999', '새 시험기관', KC_DOC), row('20200406', '23', KC, '999', '새 시험기관', KC_DOC)] });
    await importRequirements(deps, COFFEE_HS, 'import', { full: true });
    expect(deps.misses).toEqual([{ kind: 'agency', code: '999' }]);
  });

  it('flags a requirement dated after the reviewed notice revision', async () => {
    const due: string[] = [];
    const deps = tradeDeps({ '8516710000': [row('20270101', '23', KC, '105', '기술표준원', KC_DOC)] }, { onReviewDue: (d) => due.push(d) });
    await importRequirements(deps, COFFEE_HS, 'import', { full: true });
    expect(due).toEqual(['20270101']);
  });
});

describe('customs client', () => {
  const ok = '<response><header><resultCode>00</resultCode><resultMsg>정상서비스.</resultMsg></header><body><items><item><aplyStrtDt>20200406</aplyStrtDt><bfhnAffcRtmTpcd>2</bfhnAffcRtmTpcd><dcerCfrmLworCd>89</dcerCfrmLworCd><dcerCfrmLworNm>수입식품안전관리 특별법</dcerCfrmLworNm><hsSgn>1905310000</hsSgn><reqApreIttCd>005</reqApreIttCd><reqApreIttNm>식품의약품안전처</reqApreIttNm><reqCfrmIstmNm>수입식품등 수입신고확인증</reqCfrmIstmNm></item></items></body></response>';

  it('parses items and treats "00 + no items" as an empty answer', () => {
    expect(parseRequirements(ok)).toEqual([row('20200406', '89', '수입식품안전관리 특별법', '005', '식품의약품안전처', '수입식품등 수입신고확인증')]);
    expect(parseRequirements('<response><header><resultCode>00</resultCode></header><body><items/></body></response>')).toEqual([]);
  });

  it('fails on any result code other than 00 instead of returning an empty list', () => {
    expect(() => parseRequirements('<response><header><resultCode>22</resultCode><resultMsg>LIMITED</resultMsg></header></response>')).toThrow(CustomsError);
  });

  it('retries a 5xx, not a 4xx, and never puts the key in an error', async () => {
    const KEY = 'secret-key-value';
    let calls = 0;
    const flaky = createCustomsClient({
      serviceKey: KEY,
      retry: { sleep: async () => {} },
      fetchFn: (async () => {
        calls++;
        return calls < 3 ? new Response('busy', { status: 503 }) : new Response(ok);
      }) as unknown as typeof fetch,
    });
    expect(await flaky.requirements('1905310000', 'import')).toHaveLength(1);
    expect(calls).toBe(3);

    calls = 0;
    const denied = createCustomsClient({
      serviceKey: KEY,
      retry: { sleep: async () => {} },
      fetchFn: (async (u: string) => {
        calls++;
        throw new Error(`connect ETIMEDOUT ${u}`);
      }) as unknown as typeof fetch,
    });
    const err = (await denied.requirements('1905310000', 'export').catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(CustomsError);
    expect(err.message).not.toContain(KEY);
    expect(calls).toBe(3);

    calls = 0;
    const forbidden = createCustomsClient({
      serviceKey: KEY,
      retry: { sleep: async () => {} },
      fetchFn: (async () => {
        calls++;
        return new Response('no', { status: 401 });
      }) as unknown as typeof fetch,
    });
    await expect(forbidden.requirements('1905310000', 'import')).rejects.toThrow(CustomsError);
    expect(calls).toBe(1);
  });

  it('asks for imports with imexTpcd=2 and exports with 1', async () => {
    const urls: string[] = [];
    const c = createCustomsClient({ serviceKey: 'k', fetchFn: (async (u: string) => (urls.push(u), new Response(ok))) as unknown as typeof fetch });
    await c.requirements('1905310000', 'import');
    await c.requirements('1905310000', 'export');
    expect(urls[0]).toContain('imexTpcd=2');
    expect(urls[1]).toContain('imexTpcd=1');
  });
});

describe('condition rows', () => {
  it('keys rows by HS and law ID and counts statutes it cannot resolve', () => {
    const r = indexConditionRows([
      ['품목번호', '품명', '수입요건', '관계법령'],
      ['8516.71-0000', 'x', 'A', KC],
      ['8516.71-0000', 'x', 'B', '전기용품및생활용품안전관리법'], // same law, spacing differs
      ['8516.71-0000', 'x', 'C', '없는 법률'],
    ]);
    const id = resolveStatute('23', KC).law_id;
    expect(r.map[`8516710000|${id}`]).toBe('A\n\nB');
    expect(r.unresolved).toHaveLength(1);
  });
});

// --- through the app: REST and MCP ------------------------------------------------

const MASTER = new HsMaster(
  buildHsMasterFile(
    [
      ['HS부호', '적용시작일자', '적용종료일자', '한글품목명', '영문품목명'],
      ['8516710000', '41275', '46387', '커피ㆍ차를 끓이는 기기', 'Coffee or tea makers'],
      ['7318152000', '41275', '46387', '볼트(bolt)', 'Bolts'],
    ],
    { source: 't', dataset: 'x', file_name: 'x', fetched_at: 'x' },
    1,
  ),
);

const facilitator = {
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }, { x402Version: 2, scheme: 'upto', network: 'eip155:84532' }] };
  },
  async verify(): Promise<never> {
    throw new Error('verify must not be called');
  },
  async settle(): Promise<never> {
    throw new Error('settle must not be called');
  },
} as unknown as FacilitatorClient;

describe('REST route', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start() {
    const trade = tradeDeps({ '8516710000': COFFEE, '7318152000': [] });
    const deps: Deps = { nts: {} as NtsClient, cache: createCache(), hsMaster: async () => MASTER, trade };
    const x402: X402Options = { payTo: '0x0000000000000000000000000000000000000001', facilitatorUrl: 'http://127.0.0.1:1', network: 'eip155:84532', dailyFreeTier: 10, facilitatorClient: facilitator, tradeDesk: true };
    server = buildApp(deps, x402).listen(0);
    await new Promise<void>((r) => server!.once('listening', r));
    return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}${IMPORT_REQUIREMENTS_PATH}`, trade };
  }

  it('the four states', async () => {
    const { base, trade } = await start();
    // valid, no requirements (free tier summary)
    const none = await fetch(`${base}?hs_code=7318152000&free=1`);
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ has_requirements: false, requirements_checked: true });
    // valid, with requirements (test code: full, free)
    const some = await fetch(`${base}?hs_code=${TEST_HS_CODE}`);
    expect(some.status).toBe(200);
    expect(((await some.json()) as { requirement_count: number }).requirement_count).toBe(3);
    // invalid
    const bad = await fetch(`${base}?hs_code=9999999999`);
    expect(bad.status).toBe(400);
    expect(trade.customsCalls).not.toContain('9999999999:import');
    // upstream failure
    trade.customs.requirements = async () => {
      throw new CustomsError('down');
    };
    const down = await fetch(`${base}?hs_code=${TEST_HS_CODE}`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ requirements_checked: false, error: 'upstream_unavailable' });
  });

  it('answers 402 to an unpaid request without ?free=1, before calling the upstream', async () => {
    const { base, trade } = await start();
    const res = await fetch(`${base}?hs_code=7318152000`);
    expect(res.status).toBe(402);
    expect(trade.customsCalls).toEqual([]);
  });

  it('the free tier gets the summary; the test code gets the full answer without using the quota', async () => {
    const { base } = await start();
    for (let i = 0; i < 12; i++) expect((await fetch(`${base}?hs_code=${TEST_HS_CODE}`)).status).toBe(200);
    const summary = (await (await fetch(`${base}?hs_code=7318152000&free=1`)).json()) as Record<string, unknown>;
    expect(summary.detail).toBe('summary');
    const full = (await (await fetch(`${base}?hs_code=${TEST_HS_CODE}`)).json()) as Record<string, unknown>;
    expect(full.requirements).toBeTruthy();
  });
});

describe('MCP tool', () => {
  async function client(tryConsume: (u: number) => boolean) {
    const trade = tradeDeps({ '8516710000': COFFEE, '7318152000': [] });
    const deps: Deps = { nts: {} as NtsClient, cache: createCache(), hsMaster: async () => MASTER, trade };
    const server = buildMcpServer(deps, { tryConsume });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return { c, trade };
  }

  it('validates the code before spending a free lookup', async () => {
    const used: number[] = [];
    const { c, trade } = await client((u) => (used.push(u), true));
    const r = await c.callTool({ name: 'check_korea_import_requirements', arguments: { hs_code: '9999999999' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('hs_code_not_found');
    expect(used).toEqual([]);
    expect(trade.customsCalls).toEqual([]);
  });

  it('returns the full answer, spending one lookup — none for the test code', async () => {
    const used: number[] = [];
    const { c } = await client((u) => (used.push(u), true));
    const bolt = await c.callTool({ name: 'check_korea_import_requirements', arguments: { hs_code: '7318152000' } });
    expect((bolt.structuredContent as Record<string, unknown>).requirements).toEqual([]);
    const coffee = await c.callTool({ name: 'check_korea_import_requirements', arguments: { hs_code: TEST_HS_CODE } });
    expect((coffee.structuredContent as Record<string, unknown>).requirement_count).toBe(3);
    expect(used).toEqual([1]);
  });

  it('is not listed without the trade deps', async () => {
    const server = buildMcpServer({ nts: {} as NtsClient, cache: createCache() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), c.connect(b)]);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('check_korea_import_requirements');
  });
});
