/**
 * TRADE-DESK stage 5: the notice body's statute rows (annex 2 import, annex 1
 * export) and amendment detection. Table lines are copied from the notice in
 * force (제2026-46호), including its one corrupted character ("제조?수출입").
 */

import { describe, expect, it } from 'vitest';
import { annexLines, indexAnnexRows, ConditionsIndex, NOTICE_WATCH_PATH, watchAgeDays, type ConditionsFile, type NoticeInfo } from '../src/hs-conditions.js';
import { runWatch } from '../src/lawgo-job.js';
import type { LawGoClient } from '../src/lawgo.js';
import type { NameIndexStore } from '../src/name-index-store.js';
import { lawIdForDamagedTitle } from '../src/trade-dict.js';

const RULE = '├──────────────────────────┼───────────────────────┤';
const ANNEX_2 = [
  '【별표 2】세관장확인대상 수입물품',
  ' 가. 대상법령 및 물품의 범위와 구비요건',
  '┌────────────────────────┬───────────────────────┐',
  '│대상법령 및 물품의 범위                         │구비요건                                      │',
  RULE,
  '│(4) (삭제)                                      │                                              │',
  RULE,
  '│(9)「전기용품 및 생활용품 안전 관리법」해당 물  │                                              │',
  '│품                                              │                                              │',
  '│                                                │                                              │',
  '│  (가)안전인증대상 제품                         │ㅇ전기용품 및 생활용품 세관장 확인물품 확인증 │',
  '└────────────────────────┴───────────────────────┘',
  // Page break inside row (9): the table restarts with its header, then the row goes on.
  '┌────────────────────────┬───────────────────────┐',
  '│대상법령 및 물품의 범위                         │구비요건                                      │',
  RULE,
  '│  (나)안전확인대상 제품                         │ㅇ전기용품 및 생활용품 세관장 확인물품 확인증 │',
  RULE,
  '│(30)「화학무기·생물무기의 금지와 특정화학물질·    │ㅇ산업통상부장관의 수입허가서                 │',
  '│생물작용제 등의 제조?수출입 규제 등에 관한         │                                              │',
  '│법률」해당 물품 중 생물작용제, 독소                 │                                              │',
  RULE,
  '│(33)「전파법」해당 물품                             │                                              │',
  '│                                                    │                                              │',
  '│  (가)적합성평가대상 또는 적합성평가시험 신청       │ㅇ국립전파연구원장의 적합성 평가확인 또는     │',
  '│기자재                                              │사전통관확인서                                │',
  '│                                                    │                                              │',
  '│  (나)적합성평가면제 대상 기자재                    │ㅇ국립전파연구원장의 적합성 평가 면제확인서   │',
  '│                                                    │(다만, 면제확인이 생략된 경우는 제외)         │',
  '└──────────────────────────┴───────────────────────┘',
  '나. 물품별 수입요건',
];

describe('indexAnnexRows', () => {
  const { map, unresolved, rows } = indexAnnexRows(ANNEX_2);

  it('reads one entry per statute row and skips deleted rows', () => {
    expect(rows).toBe(3);
    expect(unresolved).toEqual([]);
    expect(Object.keys(map).sort()).toEqual(['001459', '001732', '000317'].sort());
  });

  it('keeps each scope paired with its documents, as laid out in the annex', () => {
    expect(map['001732'].items).toEqual([
      { scope_ko: '(33)「전파법」해당 물품', documents_ko: '' },
      {
        scope_ko: '  (가)적합성평가대상 또는 적합성평가시험 신청\n기자재',
        documents_ko: 'ㅇ국립전파연구원장의 적합성 평가확인 또는\n사전통관확인서',
      },
      {
        scope_ko: '  (나)적합성평가면제 대상 기자재',
        documents_ko: 'ㅇ국립전파연구원장의 적합성 평가 면제확인서\n(다만, 면제확인이 생략된 경우는 제외)',
      },
    ]);
  });

  it('joins a row that a page break split across two tables', () => {
    expect(map['001459'].items.map((i) => i.scope_ko.trim())).toEqual(['(9)「전기용품 및 생활용품 안전 관리법」해당 물\n품', '(가)안전인증대상 제품', '(나)안전확인대상 제품']);
  });

  it('resolves a title with one corrupted character only when exactly one statute fits', () => {
    expect(lawIdForDamagedTitle('화학무기·생물무기의 금지와 특정화학물질·생물작용제 등의 제조?수출입 규제 등에 관한 법률')).toBe('000317');
    expect(lawIdForDamagedTitle('?법')).toBeUndefined(); // fits nothing uniquely
    expect(lawIdForDamagedTitle('전파법')).toBeUndefined(); // nothing damaged: not this function's job
  });

  it('finds the annex body in the notice XML by title', () => {
    const xml =
      '<별표단위 별표키="1"><별표제목><![CDATA[HSK 10단위로 연계되는 물품의 수입요건]]></별표제목><별표내용><![CDATA[x]]></별표내용></별표단위>' +
      `<별표단위 별표키="2"><별표제목><![CDATA[세관장확인대상 수입물품]]></별표제목><별표내용>${ANNEX_2.map((l) => `<![CDATA[${l}]]><![CDATA[]]>`).join('')}</별표내용></별표단위>`;
    expect(annexLines(xml, '세관장확인대상 수입물품')).toEqual(ANNEX_2);
    expect(() => annexLines(xml, '세관장확인대상 수출물품')).toThrow(/no annex titled/);
  });

  it('serves the statute row by law ID', () => {
    const idx = new ConditionsIndex({ statute_groups: { import: map, export: {}, unresolved: [] } } as unknown as ConditionsFile);
    expect(idx.statuteGroup('import', '001732')?.items).toHaveLength(3);
    expect(idx.statuteGroup('export', '001732')).toBeUndefined();
    expect(idx.statuteGroup('import', undefined)).toBeUndefined();
  });
});

describe('runWatch (amendment detection)', () => {
  const searchXml = (serial: string, no: string, eff: string) =>
    `<AdmRulSearch><totalCnt>1</totalCnt><admrul id="1"><행정규칙명>관세법 제226조에 따른 세관장확인물품 및 확인방법 지정고시</행정규칙명>` +
    `<행정규칙일련번호>${serial}</행정규칙일련번호><발령번호>${no}</발령번호><시행일자>${eff}</시행일자></admrul></AdmRulSearch>`;
  const client = (serial: string): LawGoClient => ({
    async search() {
      return searchXml(serial, '2026-46', '20260716');
    },
    async service() {
      throw new Error('not used');
    },
  });
  const written: Record<string, unknown> = {};
  const store = (file: Partial<ConditionsFile> | null): NameIndexStore =>
    ({
      async readJson() {
        return file;
      },
      async writeJson(path: string, data: unknown) {
        written[path] = data;
      },
    }) as unknown as NameIndexStore;
  const notice = (serial: string): NoticeInfo => ({ name_ko: 'n', notice_no: '제2026-46호', effective_from: '2026-07-16', serial, url: 'u' });
  const groups = { import: {}, export: {}, unresolved: [] };
  const rebuiltAs = (serial: string) => ({ notice: notice(serial) }) as ConditionsFile;
  const NOW = () => new Date('2026-10-24T01:50:00Z');

  it('does nothing but log when the notice in force is the one indexed', async () => {
    const logs: Record<string, unknown>[] = [];
    let rebuilt = 0;
    const out = await runWatch(client('2100000282502'), store({ notice: notice('2100000282502'), statute_groups: groups }), (l) => logs.push(l), async () => (rebuilt++, rebuiltAs('x')), NOW);
    expect(out.changed).toBe(false);
    expect(rebuilt).toBe(0);
    expect(logs[0]).toMatchObject({ event: 'notice_watch', changed: false, live: { serial: '2100000282502' } });
    // The freshness record is written on every successful check, not only on change.
    expect(written[NOTICE_WATCH_PATH]).toEqual({
      checked_at: '2026-10-24T01:50:00.000Z',
      live_serial: '2100000282502',
      live_notice_no: '제2026-46호',
      indexed_serial: '2100000282502',
      rebuilt: false,
    });
  });

  it('rebuilds when the notice was amended', async () => {
    const logs: Record<string, unknown>[] = [];
    let rebuilt = 0;
    const out = await runWatch(client('2100000999999'), store({ notice: notice('2100000282502'), statute_groups: groups }), (l) => logs.push(l), async () => (rebuilt++, rebuiltAs('2100000999999')), NOW);
    expect(out.changed).toBe(true);
    expect(rebuilt).toBe(1);
    expect(written[NOTICE_WATCH_PATH]).toMatchObject({ indexed_serial: '2100000999999', rebuilt: true });
    expect(logs[0]).toMatchObject({ changed: true, live: { serial: '2100000999999' }, indexed: { serial: '2100000282502' } });
  });

  it('leaves the previous record untouched when law.go.kr does not answer', async () => {
    delete written[NOTICE_WATCH_PATH];
    const down: LawGoClient = {
      async search() {
        throw new Error('fetch failed');
      },
      async service() {
        throw new Error('not used');
      },
    };
    await expect(runWatch(down, store({ notice: notice('2100000282502'), statute_groups: groups }), () => {}, async () => rebuiltAs('x'), NOW)).rejects.toThrow();
    expect(written[NOTICE_WATCH_PATH]).toBeUndefined(); // so the last success keeps aging
  });

  it('rebuilds an index from before statute groups existed, and when there is no index at all', async () => {
    let rebuilt = 0;
    const rebuild = async () => (rebuilt++, rebuiltAs('2100000282502'));
    await runWatch(client('2100000282502'), store({ notice: notice('2100000282502') }), () => {}, rebuild);
    await runWatch(client('2100000282502'), store(null), () => {}, rebuild);
    expect(rebuilt).toBe(2);
  });
});

describe('watchAgeDays', () => {
  it('counts whole days since the last successful check', () => {
    const w = { checked_at: '2026-10-20T01:50:00Z', live_serial: 's', live_notice_no: 'n', indexed_serial: 's', rebuilt: false };
    expect(watchAgeDays(w, new Date('2026-10-23T01:49:00Z'))).toBe(2);
    expect(watchAgeDays(w, new Date('2026-10-23T01:51:00Z'))).toBe(3);
    expect(watchAgeDays(null, new Date())).toBeNull();
  });
});
