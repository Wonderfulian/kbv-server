/**
 * Client for the Korean NTS (National Tax Service) business registry API
 * hosted on api.odcloud.kr. Auth is a `serviceKey` query parameter (the
 * DECODING key from data.go.kr — set via URLSearchParams so it is encoded
 * exactly once).
 *
 * Privacy rule (DESIGN.md §11): nothing in this module may log or embed
 * business numbers, names, or the service key in error messages.
 */

export const MAX_BATCH = 100; // NTS official limit: 100 records per request

const DEFAULT_BASE_URL = 'https://api.odcloud.kr/api/nts-businessman/v1';
const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 250;

export type NtsErrorKind = 'network' | 'http' | 'quota' | 'batch_limit';

export class NtsError extends Error {
  constructor(
    readonly kind: NtsErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NtsError';
  }
}

/** One item of the /status response `data` array (raw NTS field names). */
export interface NtsStatusItem {
  b_no: string;
  b_stt?: string;
  b_stt_cd?: string;
  tax_type?: string;
  tax_type_cd?: string;
  end_dt?: string;
  utcc_yn?: string;
  tax_type_change_dt?: string;
  rbf_tax_type?: string;
  rbf_tax_type_cd?: string;
}

/** One item of the /validate request `businesses` array. */
export interface NtsValidateRequestItem {
  b_no: string;
  start_dt: string; // YYYYMMDD
  p_nm: string;
  p_nm2?: string;
  b_nm?: string;
  corp_no?: string;
  b_sector?: string;
  b_type?: string;
  b_adr?: string;
}

/** One item of the /validate response `data` array. */
export interface NtsValidateResultItem {
  b_no: string;
  valid: '01' | '02';
  valid_msg?: string;
  request_param?: NtsValidateRequestItem;
  status?: NtsStatusItem;
}

export interface NtsClientOptions {
  serviceKey: string;
  /** Injection point so tests can run without any network access. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Metrics hook — receives counts/latency only, never payloads. */
  onLatency?: (endpoint: 'status' | 'validate', ms: number, ok: boolean) => void;
}

export interface NtsClient {
  checkStatus(bNos: string[]): Promise<NtsStatusItem[]>;
  validate(items: NtsValidateRequestItem[]): Promise<NtsValidateResultItem[]>;
}

export function createNtsClient(opts: NtsClientOptions): NtsClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function buildUrl(path: 'status' | 'validate'): string {
    const url = new URL(`${baseUrl}/${path}`);
    url.searchParams.set('serviceKey', opts.serviceKey);
    return url.toString();
  }

  async function attempt(path: 'status' | 'validate', body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(buildUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new NtsError('network', `NTS ${path} request failed (network error or timeout)`);
    }
    if (res.status === 429) {
      throw new NtsError('quota', 'NTS daily quota exceeded (HTTP 429)', 429);
    }
    if (!res.ok) {
      throw new NtsError('http', `NTS ${path} request failed with HTTP ${res.status}`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new NtsError('http', `NTS ${path} returned a non-JSON response`, res.status);
    }
  }

  function isRetryable(err: unknown): boolean {
    if (!(err instanceof NtsError)) return false;
    if (err.kind === 'network') return true;
    return err.kind === 'http' && err.status !== undefined && err.status >= 500;
  }

  async function post(path: 'status' | 'validate', body: unknown, batchSize: number): Promise<unknown[]> {
    if (batchSize > MAX_BATCH) {
      throw new NtsError('batch_limit', `NTS allows at most ${MAX_BATCH} records per request (got ${batchSize})`);
    }
    const started = Date.now();
    let json: unknown;
    try {
      try {
        json = await attempt(path, body);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        json = await attempt(path, body);
      }
    } catch (err) {
      opts.onLatency?.(path, Date.now() - started, false);
      throw err;
    }
    opts.onLatency?.(path, Date.now() - started, true);
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new NtsError('http', `NTS ${path} response had an unexpected shape`);
    }
    return data;
  }

  return {
    async checkStatus(bNos) {
      return (await post('status', { b_no: bNos }, bNos.length)) as NtsStatusItem[];
    },
    async validate(items) {
      return (await post('validate', { businesses: items }, items.length)) as NtsValidateResultItem[];
    },
  };
}
