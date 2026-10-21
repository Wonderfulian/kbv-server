/**
 * law.go.kr client + connectivity check. The OC is a credential carried in the
 * query string: it must never be defaulted and never appear in an error, log
 * or saved file.
 */

import { describe, expect, it } from 'vitest';
import { createLawGoClient, LawGoError, maskOc, type LawGoClient } from '../src/lawgo.js';
import { NOTICE_TITLE, runCheck } from '../src/lawgo-job.js';

const OC = 'our-oc-value';

describe('law.go.kr client', () => {
  it('refuses to exist without an OC — no "test" fallback', () => {
    expect(() => createLawGoClient({ oc: undefined })).toThrow(LawGoError);
    expect(() => createLawGoClient({ oc: '' })).toThrow(/LAW_GO_KR_OC/);
  });

  it('sends our OC and asks for XML', async () => {
    let url = '';
    const client = createLawGoClient({
      oc: OC,
      fetchFn: (async (u: string) => {
        url = u;
        return new Response('<AdmRulSearch/>');
      }) as unknown as typeof fetch,
    });
    await client.search('admrul', { query: 'x' });
    expect(url).toContain(`OC=${OC}`);
    expect(url).toContain('type=XML');
  });

  it('masks the OC in errors, including a network error that quotes the URL', async () => {
    const client = createLawGoClient({
      oc: OC,
      fetchFn: (async (u: string) => {
        throw new Error(`connect ETIMEDOUT ${u}`);
      }) as unknown as typeof fetch,
    });
    const err = await client.search('admrul', { query: 'x' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(LawGoError);
    expect((err as Error).message).not.toContain(OC);
    expect((err as Error).message).toContain('OC=***');
  });

  it('masks the OC in an upstream error body', async () => {
    const client = createLawGoClient({
      oc: OC,
      fetchFn: (async () => new Response(`bad request for ${OC}`, { status: 500 })) as unknown as typeof fetch,
    });
    const err = (await client.service('admrul', { ID: '1' }).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(OC);
  });

  it('maskOc hides both the parameter and the bare value', () => {
    expect(maskOc(`x?OC=${OC}&target=admrul and ${OC}`, OC)).toBe('x?OC=***&target=admrul and ***');
  });
});

describe('connectivity check', () => {
  const notice = `<admrul id="1"><행정규칙일련번호>2100000282502</행정규칙일련번호><행정규칙명><![CDATA[${NOTICE_TITLE}]]></행정규칙명><발령일자>20260716</발령일자></admrul>`;
  const fake = (list: string): LawGoClient => ({
    async search(_t, p) {
      return p.nw === '2' ? '<AdmRulSearch><totalCnt>19</totalCnt></AdmRulSearch>' : list;
    },
    async service() {
      return '<AdmRulService><별표단위 a="1"><별표제목>세관장확인대상 수입물품</별표제목></별표단위><별표단위 a="2"><별표제목>세관장확인대상 수출물품</별표제목></별표단위></AdmRulService>';
    },
  });

  it('separates the three facts and reports the annexes', async () => {
    const logs: Record<string, unknown>[] = [];
    const saved: string[] = [];
    const ok = await runCheck(
      fake(`<AdmRulSearch><resultCode>00</resultCode><totalCnt>1</totalCnt>${notice}</AdmRulSearch>`),
      OC,
      async (p) => void saved.push(p),
      (i) => logs.push(i),
    );
    expect(ok).toBe(true);
    expect(logs.map((l) => l.step)).toEqual([1, 2, 3]);
    expect(logs[2]).toMatchObject({ found: true, annexes: 2, history_versions: 19 });
    expect(JSON.stringify(logs)).not.toContain(OC);
  });

  it('stops at step 2 when law.go.kr does not answer with a search result', async () => {
    const logs: Record<string, unknown>[] = [];
    const ok = await runCheck(fake(`<html>사용자 인증에 실패하였습니다 ${OC}</html>`), OC, async () => {}, (i) => logs.push(i));
    expect(ok).toBe(false);
    expect(logs[1]).toMatchObject({ step: 2, accepted: false });
    expect(JSON.stringify(logs)).not.toContain(OC);
  });

  it('flags stray whitespace in the secret without logging it', async () => {
    const logs: Record<string, unknown>[] = [];
    await runCheck(fake('<html/>'), `${OC}\n`, async () => {}, (i) => logs.push(i));
    expect(logs[0]).toMatchObject({ secret_read: true, surrounding_whitespace: true, contains_newline: true });
  });
});
