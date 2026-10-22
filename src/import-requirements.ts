/**
 * Korean import/export clearance requirements for one validated HS code
 * (TRADE-DESK stage 4; spec §3.2, §4.1).
 *
 * The unit of a requirement is statute + certificate. The upstream returns
 * one row per (statute, approving agency); several agencies under one
 * statute are alternatives — any one of them suffices — so rows are grouped
 * and agencies become an array. Counting rows would inflate the coffee
 * maker's 7 rows into 7 requirements when there are 3.
 *
 * What this module will not do: decide whether a condition applies, compute
 * a duty, or attach a meaning to a rate-type code other than A and C. Those
 * are judgements, and a wrong one costs the caller money.
 *
 * Failure never propagates sideways: without the tariff or condition index
 * the requirements are still returned (with the gap stated), and without the
 * requirements API the item name and tariff still are — under a 503 with
 * requirements_checked: false, so an outage never reads as "no requirements".
 */

import type { CustomsClient, CustomsRequirementRow, Direction } from './customs.js';
import type { ConditionsIndex, NoticeInfo } from './hs-conditions.js';
import { LAWGO_ATTRIBUTION } from './lawgo.js';
import { DOCUMENTED_RATE_TYPES, itemPath, type ItemNamesFile, type TariffIndex } from './tariff.js';
import {
  KOREAN_NAMES_NOTE,
  normalizeCertificate,
  resolveAgency,
  resolveCertificate,
  resolveStatute,
  REVIEW,
  reviewDue,
  type DictMiss,
} from './trade-dict.js';

/** Free, unmetered test code: three statutes, five alternative agencies under one of them. */
export const TEST_HS_CODE = '8516710000';

const NOTICE_NAME = '관세법 제226조에 따른 세관장확인물품 및 확인방법 지정고시';
const NOTICE_URL = 'https://www.law.go.kr/행정규칙/관세법제226조에따른세관장확인물품및확인방법지정고시';

export const SOURCE = 'Korea Customs Service (KCS)';

export const DISCLAIMER =
  "Fact lookup from public data. Not a legal customs determination. Each requirement's condition is quoted " +
  'from the governing notice in Korean, which is authoritative; this service does not decide whether a ' +
  'condition applies to your product. Confirm with a licensed customs broker or the listed agency before shipment.';

const CONDITION_NOTE =
  'Official Korean text, quoted verbatim. The English line is an unofficial aid; decisions must be based on the Korean text.';

export interface TradeDeps {
  customs: CustomsClient;
  conditions?: () => Promise<ConditionsIndex>;
  tariff?: () => Promise<TariffIndex>;
  itemNames?: () => Promise<ItemNamesFile>;
  today?: () => string;
  now?: () => Date;
  /** Dictionary gaps — codes or names the dictionary does not know yet. */
  onDictMiss?: (m: DictMiss) => void;
  /** A requirement dated after the notice revision the dictionary was reviewed against. */
  onReviewDue?: (aplyStrtDt: string) => void;
}

export interface ValidHs {
  hs_code: string;
  name_ko: string;
  name_en: string;
}

export interface TradeResult {
  status: 200 | 503;
  body: Record<string, unknown>;
}

const isoDate = (yyyymmdd: string) =>
  /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : yyyymmdd;

async function optional<T>(load: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (!load) return undefined;
  try {
    return await load();
  } catch {
    return undefined;
  }
}

function groupRequirements(
  rows: CustomsRequirementRow[],
  hs: string,
  direction: Direction,
  conditions: ConditionsIndex | undefined,
  notice: NoticeInfo | undefined,
  onMiss: (m: DictMiss) => void,
) {
  const groups = new Map<string, CustomsRequirementRow[]>();
  for (const r of rows) {
    const key = `${r.statuteCode}|${normalizeCertificate(r.certificateName)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let quoted = false;
  const requirements = [...groups.values()].map((g) => {
    const first = g[0];
    const statute = resolveStatute(first.statuteCode, first.statuteName, onMiss);
    const cert = resolveCertificate(first.certificateName, onMiss);
    const seen = new Set<string>();
    const agencies = g
      .filter((r) => (seen.has(r.agencyCode) ? false : (seen.add(r.agencyCode), true)))
      .map((r) => resolveAgency(r.agencyCode, r.agencyName, onMiss));
    const effective = g.map((r) => isoDate(r.aplyStrtDt)).sort()[0];
    const text = conditions?.lookup(direction, hs, statute.law_id);
    if (text) quoted = true;
    return {
      statute_code: statute.code,
      statute_name_ko: statute.name_ko,
      statute_name_en: statute.name_en,
      ...(statute.qualifier_ko ? { statute_qualifier_ko: statute.qualifier_ko } : {}),
      ...(statute.law_id ? { statute_law_id: statute.law_id } : {}),
      certificate_name_ko: cert.name_ko,
      certificate_name_en: cert.name_en,
      ...(cert.name_en_unofficial ? { certificate_name_en_unofficial: cert.name_en_unofficial } : {}),
      ...(cert.note ? { certificate_note: cert.note } : {}),
      effective_from: effective,
      approving_agencies: agencies,
      agencies_note:
        agencies.length > 1
          ? 'Any one of the listed agencies may issue this certificate.'
          : 'This agency issues the certificate.',
      condition: text
        ? {
            text_ko: text,
            text_en_unofficial: null,
            granularity: 'hs10',
            source: {
              notice_name_ko: notice?.name_ko ?? NOTICE_NAME,
              notice_no: notice?.notice_no ?? null,
              effective_from: notice?.effective_from ?? null,
              part:
                direction === 'export'
                  ? '별표 1의2 HSK 10단위로 연계되는 물품의 수출요건 (첨부 엑셀)'
                  : '별표 2의2 HSK 10단위로 연계되는 물품의 수입요건 (첨부 엑셀)',
              url: NOTICE_URL,
            },
            note: CONDITION_NOTE,
          }
        : null,
      ...(text
        ? {}
        : {
            condition_note: conditions
              ? "The notice's HS-level attachment has no condition for this statute and code. Check the governing notice."
              : 'The condition index is unavailable right now. Check the governing notice.',
          }),
    };
  });
  return { requirements, quoted };
}

function tariffField(tariff: TariffIndex | undefined, hs: string, direction: Direction, today: string) {
  if (direction === 'export') return { tariff: null, tariff_note: 'Tariff rates are import duties and are not given for exports.' };
  if (!tariff) return { tariff: null, tariff_note: 'The tariff index is unavailable right now.' };
  const f = tariff.file;
  const rates = tariff.ratesFor(hs, today).map((r) => ({
    type: r.type,
    ...(DOCUMENTED_RATE_TYPES[r.type] ? { type_meaning: DOCUMENTED_RATE_TYPES[r.type] } : {}),
    rate: r.rate,
    ...(r.unit_tax ? { unit_tax: r.unit_tax } : {}),
    ...(r.base_price ? { base_price: r.base_price } : {}),
    country_scope: r.country_scope,
    ...(r.use_type ? { use_type: r.use_type } : {}),
  }));
  const gaps = tariff.coverageGaps(hs, today);
  return {
    tariff: {
      source_file: f.file_name,
      source_as_of: f.source_as_of,
      next_edition_due: f.next_edition_due,
      stale: tariff.isStale(today),
      note:
        `Rates as published in the source file${f.source_as_of ? ` dated ${f.source_as_of}` : ''}; amendments ` +
        'after that date are not included until the next edition. Rate types other than A and C are given as ' +
        'codes without interpretation — confirm their meaning and eligibility with the Korea Customs Service.',
      rates,
      ...(gaps.length
        ? {
            coverage_gaps: gaps,
            coverage_gaps_note:
              'These rate types have rows in the source file that ended before today and nothing after them. ' +
              'That means the source file has no data for this period — not that no such rate exists.',
          }
        : {}),
      ...(tariff.has(hs) ? {} : { no_rates_note: 'The source file lists no rates for this code.' }),
    },
  };
}

/**
 * `full` = paid (or the free test code): statutes, agencies, certificates and
 * quoted conditions. Otherwise the summary the free tier gives: whether the
 * code is restricted and how many requirements, item name and tariff.
 */
export async function importRequirements(
  deps: TradeDeps,
  hs: ValidHs,
  direction: Direction,
  opts: { full: boolean },
): Promise<TradeResult> {
  const today = deps.today?.() ?? new Date().toISOString().slice(0, 10);
  const [conditions, tariff, names] = await Promise.all([
    optional(deps.conditions),
    optional(deps.tariff),
    optional(deps.itemNames),
  ]);
  const base = {
    hs_code: hs.hs_code,
    direction,
    item_name_en: hs.name_en,
    item_name_ko: hs.name_ko,
    ...(names ? { item_path: itemPath(names, hs.hs_code) } : {}),
    hs_code_valid: true,
  };
  const tariffPart = tariffField(tariff, hs.hs_code, direction, today);
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();

  let rows: CustomsRequirementRow[];
  try {
    rows = await deps.customs.requirements(hs.hs_code, direction);
  } catch {
    return {
      status: 503,
      body: {
        error: 'upstream_unavailable',
        message: 'The Korea Customs Service requirements service could not be reached. This is not a "no requirements" answer — retry shortly.',
        ...base,
        requirements_checked: false,
        ...tariffPart,
        checked_at: checkedAt,
        source: SOURCE,
      },
    };
  }

  const misses = new Map<string, DictMiss>();
  const onMiss = (m: DictMiss) => misses.set(JSON.stringify(m), m);
  const { requirements, quoted } = groupRequirements(rows, hs.hs_code, direction, conditions, conditions?.file.notice, onMiss);
  for (const m of misses.values()) deps.onDictMiss?.(m);
  const due = rows.map((r) => r.aplyStrtDt).filter(reviewDue).sort().at(-1);
  if (due) deps.onReviewDue?.(due);

  const notice = conditions?.file.notice;
  const body: Record<string, unknown> = {
    ...base,
    requirements_checked: true,
    has_requirements: requirements.length > 0,
    requirement_count: requirements.length,
  };
  if (opts.full) {
    body.requirements = requirements;
    if (requirements.length === 0) {
      body.requirements_note =
        'The Korea Customs Service lists no customs-chief confirmation requirement for this HS code and direction. ' +
        'This is a definitive result for a valid code, not a lookup failure.';
    }
    body.governing_notice = {
      name_ko: notice?.name_ko ?? NOTICE_NAME,
      notice_no: notice?.notice_no ?? null,
      effective_from: notice?.effective_from ?? REVIEW.notice_effective,
      url: NOTICE_URL,
    };
    body.names_note = KOREAN_NAMES_NOTE;
    if (quoted) body.attribution = LAWGO_ATTRIBUTION;
  } else {
    body.detail = 'summary';
    body.detail_note =
      'Statutes, alternative approving agencies, certificate names and the conditions quoted from the governing ' +
      `notice are in the paid response (x402). HS ${TEST_HS_CODE} returns the full response free.`;
  }
  Object.assign(body, tariffPart, { checked_at: checkedAt, source: SOURCE, disclaimer: DISCLAIMER });
  return { status: 200, body };
}
