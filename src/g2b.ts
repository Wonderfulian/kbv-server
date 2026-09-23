/**
 * Public Procurement Service (나라장터) vendor registry client.
 *
 * This is where the small and mid-sized companies live: DART only covers
 * disclosure filers (~120k), while any company bidding for public contracts
 * registers here. It has no English names to speak of (0.3% of rows), so it
 * complements DART rather than replacing it — Korean-name coverage for SMEs.
 *
 * API shape, learned the hard way (all three cost an afternoon once):
 *   - dates are 12 digits, YYYYMMDDHHmm; 8 digits returns "DATE Format 에러"
 *   - a query window may not exceed about a month
 *   - errors come back under `nkoneps.com.response.ResponseError`, not the
 *     standard envelope, so a naive parser reports "0 rows" for a hard failure
 *
 * The date filter applies to `rgstDt` — the day a vendor *registered* with the
 * procurement system (verified: 200/200 rows fell inside the queried month),
 * not the day their record last changed. Collecting a period therefore yields
 * the vendors who joined then, which is why a full backfill walks the years.
 *
 * FIELD MINIMIZATION: the API returns ceoNm, telNo, faxNo and a full street
 * address. We keep the business number, the Korean name, the English name if
 * present, and the region truncated to city/district. Everything else — the
 * representative's name above all — is dropped here, at the boundary.
 */

const ENDPOINT = 'https://apis.data.go.kr/1230000/ao/UsrInfoService02/getPrcrmntCorpBasicInfo02';

/** Identity-only view of a registered vendor. */
export interface G2bVendor {
  business_number: string;
  name: string;
  name_en?: string;
  /** City/district only (e.g. "경기도 남양주시") — never a street address. */
  region?: string;
}

export class G2bError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'G2bError';
  }
}

/**
 * Cuts an address back to its first two administrative levels. A sole
 * proprietor's registered address is often their home, so the street part is
 * not ours to store or serve.
 */
export function truncateRegion(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const parts = address.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.slice(0, 2).join(' ');
}

/** Raw row, as the upstream sends it. Only the listed fields are read. */
interface RawVendor {
  bizno?: string;
  corpNm?: string;
  engCorpNm?: string;
  rgnNm?: string;
}

export function toVendor(raw: RawVendor): G2bVendor | null {
  const number = (raw.bizno ?? '').replace(/\D/g, '');
  const name = (raw.corpNm ?? '').trim();
  if (number.length !== 10 || !name) return null;
  const nameEn = (raw.engCorpNm ?? '').trim();
  const region = truncateRegion(raw.rgnNm);
  return {
    business_number: number,
    name,
    ...(nameEn ? { name_en: nameEn } : {}),
    ...(region ? { region } : {}),
  };
}

/** Inclusive month windows covering [start, end], newest first. */
export function monthWindows(start: Date, end: Date): { from: string; to: string; label: string }[] {
  const windows: { from: string; to: string; label: string }[] = [];
  let year = end.getUTCFullYear();
  let month = end.getUTCMonth();
  const startKey = start.getUTCFullYear() * 12 + start.getUTCMonth();

  while (year * 12 + month >= startKey) {
    const mm = String(month + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    windows.push({
      from: `${year}${mm}010000`,
      to: `${year}${mm}${String(lastDay).padStart(2, '0')}2359`,
      label: `${year}-${mm}`,
    });
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return windows;
}

export interface G2bClientOptions {
  serviceKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Rows per request; the API accepts up to 999. */
  pageSize?: number;
}

export interface G2bClient {
  /** Every vendor registered within one month window. */
  fetchMonth(window: { from: string; to: string }): Promise<G2bVendor[]>;
}

export function createG2bClient(opts: G2bClientOptions): G2bClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pageSize = Math.min(opts.pageSize ?? 999, 999);

  return {
    async fetchMonth(window) {
      const vendors: G2bVendor[] = [];
      for (let page = 1; ; page++) {
        const url = new URL(ENDPOINT);
        url.searchParams.set('serviceKey', opts.serviceKey);
        url.searchParams.set('type', 'json');
        url.searchParams.set('inqryDiv', '1');
        url.searchParams.set('inqryBgnDt', window.from);
        url.searchParams.set('inqryEndDt', window.to);
        url.searchParams.set('pageNo', String(page));
        url.searchParams.set('numOfRows', String(pageSize));

        const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new G2bError(`G2B responded ${res.status}`);
        const body = (await res.json()) as {
          response?: { body?: { items?: RawVendor[]; totalCount?: number } };
          'nkoneps.com.response.ResponseError'?: { header?: { resultCode?: string; resultMsg?: string } };
        };

        // The non-standard error envelope: without this check a failure looks
        // exactly like an empty month.
        const err = body['nkoneps.com.response.ResponseError']?.header;
        if (err) throw new G2bError(err.resultMsg ?? 'G2B error', err.resultCode);

        const rows = body.response?.body?.items ?? [];
        for (const raw of rows) {
          const vendor = toVendor(raw);
          if (vendor) vendors.push(vendor);
        }
        if (rows.length < pageSize) return vendors;
      }
    },
  };
}
