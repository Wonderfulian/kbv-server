/**
 * Korea Customs Service — goods subject to customs-chief confirmation
 * (관세청_세관장확인대상물품, data.go.kr 15101589).
 *
 * GET .../retrieveCcctLworCd/getRetrieveCcctLworCd?hsSgn=<10 digits>&imexTpcd=1|2
 * Answers XML; one <item> per (statute, approving agency) — rows are NOT
 * requirements: several agencies under one statute are alternatives.
 *
 * Two things this client refuses to blur:
 *   - "No items" for a valid code is a definitive empty answer. Anything other
 *     than resultCode 00 is a failure, never an empty list — the upstream
 *     answers a nonexistent code with "00 + no items" too, which is why codes
 *     are validated against the HS master before they get here.
 *   - The service key rides in the query string: errors never carry the URL.
 */

import { RetryableError, withRetry, type RetryOptions } from './retry.js';

const ENDPOINT = 'https://apis.data.go.kr/1220000/retrieveCcctLworCd/getRetrieveCcctLworCd';

export type Direction = 'import' | 'export';

export interface CustomsRequirementRow {
  /** YYYYMMDD — the designation-notice revision that last set this row. */
  aplyStrtDt: string;
  statuteCode: string;
  statuteName: string;
  agencyCode: string;
  agencyName: string;
  certificateName: string;
}

export class CustomsError extends Error {}

export type CustomsFailure = 'network' | 'upstream';
/** Host of the requirements API, for a keyless reachability probe. */
export const CUSTOMS_PROBE_URL = ENDPOINT;

export interface CustomsClient {
  requirements(hs: string, direction: Direction): Promise<CustomsRequirementRow[]>;
}

function tag(block: string, name: string): string {
  const open = block.indexOf(`<${name}>`);
  if (open < 0) return '';
  const close = block.indexOf(`</${name}>`, open);
  return close < 0 ? '' : block.slice(open + name.length + 2, close).trim();
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);

export function parseRequirements(xml: string): CustomsRequirementRow[] {
  const code = tag(xml, 'resultCode');
  if (code !== '00') throw new CustomsError(`customs API answered resultCode ${code || '(none)'}: ${decode(tag(xml, 'resultMsg')).slice(0, 120)}`);
  return xml
    .split('<item>')
    .slice(1)
    .map((b) => b.slice(0, b.indexOf('</item>')))
    .map((b) => ({
      aplyStrtDt: tag(b, 'aplyStrtDt'),
      statuteCode: tag(b, 'dcerCfrmLworCd'),
      statuteName: decode(tag(b, 'dcerCfrmLworNm')),
      agencyCode: tag(b, 'reqApreIttCd'),
      agencyName: decode(tag(b, 'reqApreIttNm')),
      certificateName: decode(tag(b, 'reqCfrmIstmNm')),
    }));
}

export function createCustomsClient(opts: {
  serviceKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryOptions;
  /**
   * `failure` on errors: "network" when no HTTP response came back at all
   * (connect/timeout — the signal for a broken instance egress), "upstream"
   * when the host answered with an error (it was reachable).
   */
  onLatency?: (ms: number, ok: boolean, failure?: CustomsFailure) => void;
}): CustomsClient {
  if (!opts.serviceKey) throw new CustomsError('customs client needs the data.go.kr service key');
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let lastFailure: CustomsFailure = 'upstream';
  async function once(hs: string, direction: Direction): Promise<CustomsRequirementRow[]> {
    lastFailure = 'upstream';
    const qs = new URLSearchParams({ serviceKey: opts.serviceKey, hsSgn: hs, imexTpcd: direction === 'export' ? '1' : '2' });
    let res: Response;
    try {
      res = await fetchFn(`${ENDPOINT}?${qs.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Deliberately no URL and no upstream message here: both can carry the key.
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      lastFailure = 'network';
      throw new RetryableError(`customs API request failed${cause ? ` (${cause})` : ''}`);
    }
    if (res.status >= 500) throw new RetryableError(`customs API HTTP ${res.status}`);
    if (!res.ok) throw new CustomsError(`customs API HTTP ${res.status}`);
    return parseRequirements(await res.text());
  }

  return {
    async requirements(hs, direction) {
      const started = Date.now();
      try {
        const rows = await withRetry(() => once(hs, direction), opts.retry);
        opts.onLatency?.(Date.now() - started, true);
        return rows;
      } catch (err) {
        opts.onLatency?.(Date.now() - started, false, lastFailure);
        if (err instanceof RetryableError) throw new CustomsError(err.message);
        throw err;
      }
    },
  };
}
