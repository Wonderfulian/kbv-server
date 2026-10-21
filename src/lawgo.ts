/**
 * Ministry of Government Legislation open API (law.go.kr DRF) client.
 *
 * Two rules this file exists to keep:
 *   - No default OC. The documented example value ("test") is shared by
 *     everyone; if the secret binding went missing and calls quietly fell back
 *     to it, they would keep succeeding and nobody would notice the
 *     deployment was not using its own credential. Missing means failure.
 *   - The OC travels in the query string, so any URL or upstream text that
 *     reaches an error or a log is masked first.
 *
 * Calls are not IP-restricted on purpose: Cloud Run's outbound IP is not
 * fixed, so the registration leaves the server IP empty. If calls start
 * failing, check the approval and the OC — do not "fix" it by registering an IP.
 *
 * Attribution is mandatory for anything quoted from these responses:
 * "Source: Ministry of Government Legislation (법제처), law.go.kr".
 */

export const LAWGO_ATTRIBUTION = 'Source: Ministry of Government Legislation (법제처), law.go.kr';
const BASE = 'https://www.law.go.kr/DRF';

export class LawGoError extends Error {}

export function maskOc(text: string, oc: string): string {
  let out = text.replace(/([?&]OC=)[^&#\s"'<]*/gi, '$1***');
  if (oc) out = out.split(oc).join('***');
  return out;
}

export interface LawGoClient {
  /** DRF lawSearch.do (list). Returns the raw XML. */
  search(target: string, params: Record<string, string>): Promise<string>;
  /** DRF lawService.do (body). Returns the raw XML. */
  service(target: string, params: Record<string, string>): Promise<string>;
}

export function createLawGoClient(opts: { oc: string | undefined; fetchFn?: typeof fetch; timeoutMs?: number }): LawGoClient {
  const oc = opts.oc;
  if (!oc) throw new LawGoError('LAW_GO_KR_OC is not set — refusing to call law.go.kr without our own OC.');
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function call(endpoint: 'lawSearch.do' | 'lawService.do', target: string, params: Record<string, string>): Promise<string> {
    const qs = new URLSearchParams({ OC: oc as string, target, type: 'XML', ...params });
    let res: Response;
    try {
      res = await fetchFn(`${BASE}/${endpoint}?${qs.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // undici puts the URL in some messages; never let it through unmasked.
      // The cause code (ETIMEDOUT, ECONNRESET, a TLS code…) is what tells a
      // network block apart from a rejected credential.
      throw new LawGoError(maskOc(`law.go.kr ${endpoint} ${target} failed: ${describeNetworkError(err)}`, oc as string));
    }
    const body = await res.text();
    if (!res.ok) throw new LawGoError(maskOc(`law.go.kr ${endpoint} ${target} HTTP ${res.status}: ${body.slice(0, 200)}`, oc as string));
    return body;
  }

  return {
    search: (target, params) => call('lawSearch.do', target, params),
    service: (target, params) => call('lawService.do', target, params),
  };
}

/** "fetch failed" alone hides the reason; undici keeps it on err.cause. */
export function describeNetworkError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string; cause?: { code?: string } } };
  const code = e.cause?.code ?? e.cause?.cause?.code;
  return [e.message ?? String(err), code ? `cause=${code}` : '', e.cause?.message ? `(${e.cause.message})` : '']
    .filter(Boolean)
    .join(' ');
}

/** First text of <tag>…</tag>, CDATA and inline markup stripped. */
export function xmlText(xml: string, tag: string): string | undefined {
  const open = xml.indexOf(`<${tag}>`);
  if (open < 0) return undefined;
  const close = xml.indexOf(`</${tag}>`, open);
  if (close < 0) return undefined;
  return xml
    .slice(open + tag.length + 2, close)
    .replace('<![CDATA[', '')
    .replace(']]>', '')
    .replace(/<[^>]+>/g, '')
    .trim();
}
