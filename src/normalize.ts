/**
 * Pure functions that turn raw NTS responses (Korean text + numeric codes)
 * into the English-normalized KBV schema from DESIGN.md §6. No I/O here,
 * which keeps everything unit-testable.
 */

import type { NtsStatusItem } from './nts.js';

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

export type BusinessStatus = 'active' | 'suspended' | 'closed' | 'not_registered';
export type TaxType = 'general' | 'simplified' | 'exempt' | 'non_profit' | 'unknown';

export const SOURCE = 'Korea National Tax Service (NTS)' as const;

/** Output schema of check_korean_business_status (DESIGN.md §6.1). */
export interface StatusResult {
  business_number: string;
  status: BusinessStatus;
  status_code_raw: string;
  tax_type: TaxType;
  closed_date: string | null;
  checked_at: string;
  source: typeof SOURCE;
  cache: boolean;
}

/** Output schema of verify_korean_business (DESIGN.md §6.2). */
export interface VerifyResult extends StatusResult {
  identity_match: boolean;
}

/** Accepts "123-45-67890", "123 45 67890", "1234567890" → "1234567890". */
export function normalizeBusinessNumber(input: string): string {
  const digits = input.replace(/[-\s]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    throw new InvalidInputError(
      'business_number must be a 10-digit Korean business registration number (hyphens/spaces allowed, e.g. "123-45-67890")',
    );
  }
  return digits;
}

/** NTS "20230131" → ISO "2023-01-31"; empty/missing → null. */
export function toIsoDate(yyyymmdd: string | null | undefined): string | null {
  if (!yyyymmdd) return null;
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** ISO "1999-05-01" → NTS "19990501". */
export function toNtsDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new InvalidInputError('opening_date must be in YYYY-MM-DD format (e.g. "1999-05-01")');
  }
  return isoDate.replace(/-/g, '');
}

const STATUS_BY_CODE: Record<string, BusinessStatus> = {
  '01': 'active',
  '02': 'suspended',
  '03': 'closed',
};

/**
 * Unregistered numbers come back with an empty b_stt_cd and a tax_type
 * message ("국세청에 등록되지 않은 사업자등록번호입니다."). Unrecognized
 * non-empty codes also fall through to not_registered, with the raw code
 * preserved in status_code_raw so nothing is silently lost.
 */
export function mapStatus(item: NtsStatusItem): { status: BusinessStatus; raw: string } {
  const raw = item.b_stt_cd ?? '';
  return { status: STATUS_BY_CODE[raw] ?? 'not_registered', raw };
}

const TAX_TYPE_BY_CODE: Record<string, TaxType> = {
  '01': 'general', // 부가가치세 일반과세자
  '02': 'simplified', // 부가가치세 간이과세자
  '03': 'simplified', // 과세특례자 (legacy 간이과세)
  '04': 'exempt', // 면세사업자
  '05': 'non_profit', // 비영리법인/고유번호 단체/국가기관
  '06': 'non_profit', // 고유번호가 부여된 단체
  '07': 'simplified', // 간이과세자(세금계산서 발급사업자)
};

/** Primary lookup by tax_type_cd; falls back to keywords in the Korean text. */
export function mapTaxType(taxTypeCd: string | undefined, taxTypeText?: string): TaxType {
  if (taxTypeCd && TAX_TYPE_BY_CODE[taxTypeCd]) return TAX_TYPE_BY_CODE[taxTypeCd];
  if (taxTypeText) {
    if (taxTypeText.includes('등록되지 않은')) return 'unknown';
    if (taxTypeText.includes('간이')) return 'simplified';
    if (taxTypeText.includes('일반과세')) return 'general';
    if (taxTypeText.includes('면세')) return 'exempt';
    if (/비영리|고유번호|국가기관/.test(taxTypeText)) return 'non_profit';
  }
  return 'unknown';
}

export function buildStatusResult(
  businessNumber: string,
  item: NtsStatusItem,
  opts: { cache: boolean; checkedAt: string },
): StatusResult {
  const { status, raw } = mapStatus(item);
  return {
    business_number: businessNumber,
    status,
    status_code_raw: raw,
    tax_type: status === 'not_registered' ? 'unknown' : mapTaxType(item.tax_type_cd, item.tax_type),
    closed_date: status === 'closed' ? toIsoDate(item.end_dt) : null,
    checked_at: opts.checkedAt,
    source: SOURCE,
    cache: opts.cache,
  };
}
