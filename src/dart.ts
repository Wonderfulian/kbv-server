/**
 * OpenDART client — the only public source with English company names
 * (119,433 companies, 99.2% carry one), which is what lets a foreign agent
 * search for "Samsung Electronics" instead of a 10-digit number.
 *
 * Two calls matter here:
 *   corpCode.xml  one ZIP with every filer's code + Korean + English name
 *   company.json  per company; the only place the business number appears
 *
 * FIELD MINIMIZATION: company.json returns 19 fields including ceo_nm, adres
 * and jurir_no. We keep four (corp_code, names, business number) and drop the
 * rest at the boundary, so personal data never reaches our storage layer.
 */

import { inflateRawSync } from 'node:zlib';

const BASE = 'https://opendart.fss.or.kr/api';

export interface DartCorp {
  corp_code: string;
  name: string;
  name_en?: string;
  listed: boolean;
}

export interface DartClient {
  /** Bulk identity file — one request for the whole registry. */
  fetchCorpCodes(): Promise<DartCorp[]>;
  /** Resolves a corp_code to its business number (null when DART has none). */
  fetchBusinessNumber(corpCode: string): Promise<string | null>;
}

export class DartError extends Error {
  constructor(
    message: string,
    readonly status?: string,
  ) {
    super(message);
    this.name = 'DartError';
  }
}

/**
 * Extracts the single member of a ZIP archive. DART ships corpCode.xml this
 * way; pulling in a ZIP library for one 3 MB file would be heavier than
 * reading the central directory ourselves.
 */
export function unzipSingleFile(zip: Buffer): Buffer {
  const eocd = zip.lastIndexOf(0x06054b50 & 0xff) === -1 ? -1 : findSignature(zip, 0x06054b50);
  if (eocd < 0) throw new DartError('not a ZIP archive (no end-of-central-directory record)');
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(centralOffset) !== 0x02014b50) throw new DartError('corrupt ZIP central directory');

  const method = zip.readUInt16LE(centralOffset + 10);
  const compressedSize = zip.readUInt32LE(centralOffset + 20);
  const nameLen = zip.readUInt16LE(centralOffset + 28);
  const extraLen = zip.readUInt16LE(centralOffset + 30);
  const commentLen = zip.readUInt16LE(centralOffset + 32);
  const localOffset = zip.readUInt32LE(centralOffset + 42);
  void nameLen;
  void extraLen;
  void commentLen;

  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new DartError('corrupt ZIP local header');
  const localNameLen = zip.readUInt16LE(localOffset + 26);
  const localExtraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const data = zip.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new DartError(`unsupported ZIP compression method ${method}`);
}

function findSignature(buf: Buffer, signature: number): number {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(signature);
  return buf.lastIndexOf(needle);
}

const LIST_RE = /<list>([\s\S]*?)<\/list>/g;

function tag(block: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim() ?? '';
}

/** Parses corpCode.xml, keeping only identity fields. */
export function parseCorpCodes(xml: string): DartCorp[] {
  const out: DartCorp[] = [];
  let m: RegExpExecArray | null;
  LIST_RE.lastIndex = 0;
  while ((m = LIST_RE.exec(xml))) {
    const block = m[1];
    const corpCode = tag(block, 'corp_code');
    const name = tag(block, 'corp_name');
    if (!corpCode || !name) continue;
    const nameEn = tag(block, 'corp_eng_name');
    out.push({
      corp_code: corpCode,
      name,
      ...(nameEn ? { name_en: nameEn } : {}),
      listed: Boolean(tag(block, 'stock_code')),
    });
  }
  return out;
}

export interface DartClientOptions {
  apiKey: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createDartClient(opts: DartClientOptions): DartClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  async function get(path: string, params: Record<string, string>): Promise<Response> {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('crtfc_key', opts.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new DartError(`DART responded ${res.status}`);
    return res;
  }

  return {
    async fetchCorpCodes() {
      const res = await get('corpCode.xml', {});
      const body = Buffer.from(await res.arrayBuffer());
      // An error is returned as a small JSON body instead of a ZIP.
      if (body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) {
        throw new DartError(`corpCode.xml did not return a ZIP: ${body.toString('utf8').slice(0, 200)}`);
      }
      return parseCorpCodes(unzipSingleFile(body).toString('utf8'));
    },

    async fetchBusinessNumber(corpCode) {
      const res = await get('company.json', { corp_code: corpCode });
      const raw = (await res.json()) as { status?: string; message?: string; bizr_no?: string };
      // 013 = no data for this company; not an error worth failing the build.
      if (raw.status === '013') return null;
      if (raw.status !== '000') throw new DartError(raw.message ?? 'DART error', raw.status);
      const digits = (raw.bizr_no ?? '').replace(/\D/g, '');
      // Everything else in the payload (ceo_nm, jurir_no, adres, phone, ...)
      // is intentionally discarded here rather than passed upward.
      return digits.length === 10 ? digits : null;
    },
  };
}
