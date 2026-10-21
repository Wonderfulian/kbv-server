/**
 * English dictionary for Korean import/export clearance requirements
 * (TRADE-DESK stage 2).
 *
 * The customs requirements API answers in Korean codes and names. A foreign
 * agent cannot use it untranslated, so this maps every code to an OFFICIAL
 * English name — never a literal translation:
 *   - statutes: the Ministry of Government Legislation's English law titles
 *     (law.go.kr English laws), recorded with the law ID and the date of the
 *     English version used;
 *   - agencies: the name each agency uses for itself on its own website,
 *     with the page it was confirmed on.
 * Anything without a confirmed official name stays `name_en: null` and the
 * Korean name is returned as-is. Unknown codes are counted (see resolve*),
 * never filled in by translation.
 *
 * How this goes quietly wrong, and what guards it:
 *   - The API's own Korean agency names are partly out of date (노동부 for
 *     고용노동부, 미래창조과학부 for 과학기술정보통신부, 광주광역시 and 전라남도
 *     after their 2026-07-01 merger). Entries are keyed by CODE and describe
 *     the agency as it is now, with `status` saying what changed.
 *   - Agencies rename and merge; an agency's own site can still show the old
 *     name (the Gwangju English site after the merger). REVIEW.notice_effective
 *     records which revision of the designation notice this was reviewed
 *     against: a requirement with a later effective date (aplyStrtDt) means
 *     the notice has been revised since, and `reviewDue` flags it.
 *   - `bfhnAffcRtmTpcd` is "2" on every row observed and is not exposed.
 */

export const REVIEW = {
  reviewed_on: '2026-10-21',
  /** Designation notice revision the dictionary was checked against (관세청 고시 제2026-46호). */
  notice_effective: '2026-07-16',
  /** API sample the coverage was measured on: 1,416 HS codes, both directions. */
  sample: '1,416 HSK codes (every 8th of 11,327), import and export, 2026-10-20/21',
} as const;

export interface StatuteEntry {
  /** Official Korean title as currently in force. */
  name_ko: string;
  name_en: string;
  /** law.go.kr 법령ID — stable across amendments; use it to re-check the English title. */
  law_id: string;
  /** Promulgation date of the English version the title was taken from. */
  en_version: string;
  /** Qualifier the API appends to some codes, e.g. 허가 (permit) / 검역 (quarantine). Untranslated. */
  qualifier_ko?: string;
}

const S = (name_ko: string, name_en: string, law_id: string, en_version: string, qualifier_ko?: string): StatuteEntry =>
  qualifier_ko ? { name_ko, name_en, law_id, en_version, qualifier_ko } : { name_ko, name_en, law_id, en_version };

/**
 * The 43 statutes named in the designation notice's import and export annexes
 * (관세청 고시 제2026-46호 별표), by normalized Korean title. English titles
 * from law.go.kr English laws, looked up 2026-10-21.
 */
const STATUTES_BY_TITLE: Record<string, Omit<StatuteEntry, 'qualifier_ko'>> = Object.fromEntries(
  (
    [
      ['약사법', 'Pharmaceutical Affairs Act', '001783', '2024-12-20'],
      ['마약류 관리에 관한 법률', 'Narcotics Control Act', '002025', '2025-04-01'],
      ['수입식품안전관리 특별법', 'Special Act on Imported Food Safety Control', '012247', '2025-03-18'],
      ['식물방역법', 'Plant Protection Act', '001513', '2026-06-16'],
      ['사료관리법', 'Control of Livestock and Fish Feed Act', '001499', '2023-10-24'],
      ['가축전염병 예방법', 'Act on the Prevention of Contagious Animal Diseases', '001504', '2025-07-22'],
      ['전기용품 및 생활용품 안전관리법', 'Electrical Appliances and Consumer Products Safety Control Act', '001459', '2025-10-01'],
      ['폐기물의 국가간 이동 및 그 처리에 관한 법률', 'Act on the Transboundary Movement of Hazardous Wastes and Their Disposal', '000154', '2025-10-01'],
      ['오존층 보호 등을 위한 특정물질의 관리에 관한 법률', 'Act on the Management of Specific Substances for the Protection of the Ozone Layer', '000324', '2026-03-10'],
      ['방위사업법', 'Defense Acquisition Program Act', '010107', '2026-03-10'],
      ['화학물질관리법', 'Chemical Substances Control Act', '000162', '2025-10-01'],
      ['석면안전관리법', 'Asbestos Safety Management Act', '011384', '2025-10-01'],
      ['원자력안전법', 'Nuclear Safety Act', '011435', '2024-10-22'],
      ['총포·도검·화약류 등의 안전관리에 관한 법률', 'Act on the Safety Management of Guns, Swords, and Explosives', '001642', '2025-01-07'],
      ['야생생물 보호 및 관리에 관한 법률', 'Wildlife Protection and Management Act', '009683', '2025-11-11'],
      ['남북교류협력에 관한 법률', 'Inter-Korean Exchange and Cooperation Act', '001434', '2025-10-01'],
      ['비료관리법', 'Fertilizer Control Act', '000416', '2025-10-01'],
      ['먹는물관리법', 'Drinking Water Management Act', '000165', '2025-10-01'],
      ['종자산업법', 'Seed Industry Act', '000422', '2022-12-27'],
      ['화장품법', 'Cosmetics Act', '002015', '2025-04-01'],
      ['의료기기법', 'Medical Devices Act', '009514', '2025-12-30'],
      ['인체조직안전 및 관리 등에 관한 법률', 'Safety and Management of Human Tissue Act', '009609', '2024-01-23'],
      ['통신비밀보호법', 'Protection of Communications Secrets Act', '000036', '2025-01-31'],
      ['산업안전보건법', 'Occupational Safety and Health Act', '001766', '2025-10-01'],
      ['화학무기·생물무기의 금지와 특정화학물질·생물작용제 등의 제조·수출입 규제 등에 관한 법률', 'Act on the Control of the Manufacture, Export and Import of Specific Chemical Substances and Biological Agents for the Prohibition of Chemical and Biological Weapons', '000317', '2022-02-03'],
      ['수산생물질병 관리법', 'Aquatic Organism Disease Control Act', '010602', '2023-06-20'],
      ['전파법', 'Radio Waves Act', '001732', '2025-10-01'],
      ['감염병의 예방 및 관리에 관한 법률', 'Infectious Disease Control and Prevention Act', '001792', '2025-12-23'],
      ['고압가스 안전관리법', 'High-Pressure Gas Safety Control Act', '001850', '2026-03-10'],
      ['어린이제품 안전 특별법', "Special Act on the Safety of Children's Products", '012070', '2025-10-01'],
      ['계량에 관한 법률', 'Measurement Act', '001457', '2025-10-01'],
      ['위생용품 관리법', 'Cleansing and Hygiene Products Control Act', '012863', '2025-11-11'],
      ['농약관리법', 'Pesticide Control Act', '001514', '2026-05-12'],
      ['목재의 지속가능한 이용에 관한 법률', 'Act on the Sustainable Use of Timbers', '011620', '2021-08-17'],
      ['생물다양성 보전 및 이용에 관한 법률', 'Act on the Conservation and Use of Biological Diversity', '011540', '2025-10-01'],
      ['생활주변방사선 안전관리법', 'Act on Protective Action Guidelines against Radiation in the Natural Environment', '011433', '2024-01-23'],
      ['생활화학제품 및 살생물제의 안전관리에 관한 법률', 'Consumer Chemical Products and Biocides Safety Control Act', '013098', '2024-03-19'],
      ['액화석유가스의 안전관리 및 사업법', 'Safety Control and Business of Liquefied Petroleum Gas Act', '001849', '2025-10-01'],
      ['에너지이용 합리화법', 'Energy Use Rationalization Act', '001867', '2025-12-02'],
      ['체외진단의료기기법', 'Act on In Vitro Diagnostic Medical Devices', '013481', '2025-04-01'],
      ['외국환거래법', 'Foreign Exchange Transactions Act', '001525', '2021-06-15'],
      ['문화유산의 보존 및 활용에 관한 법률', 'Act on Conservation and Utilization of Cultural Heritage', '001607', '2025-10-01'],
      ['농업생명자원의 보존·관리 및 이용에 관한 법률', 'Act on the Conservation, Management, and Use of Agricultural Bio-Resources', '010499', '2019-08-27'],
    ] as const
  ).map(([ko, en, id, ver]) => [normalizeTitle(ko), { name_ko: ko, name_en: en, law_id: id, en_version: ver }]),
);

/** Spacing and middle-dot variants differ between the API, the notice and law.go.kr. */
export function normalizeTitle(s: string): string {
  return s.replace(/[\s·ㆍ･・]/g, '');
}

function statute(title: string, qualifier_ko?: string): StatuteEntry {
  const base = STATUTES_BY_TITLE[normalizeTitle(title)];
  if (!base) throw new Error(`trade-dict: no statute titled ${title}`);
  return qualifier_ko ? { ...base, qualifier_ko } : { ...base };
}

/** API statute code (dcerCfrmLworCd) -> statute. Codes as observed in the API sample. */
export const STATUTES: Record<string, StatuteEntry> = {
  '01': statute('약사법'),
  '10': statute('사료관리법'),
  '11': statute('농약관리법'),
  '12': statute('식물방역법'),
  '13': statute('가축전염병 예방법'),
  '21': statute('액화석유가스의 안전관리 및 사업법'),
  '22': statute('고압가스 안전관리법'),
  '23': statute('전기용품 및 생활용품 안전관리법'),
  '27': statute('화학무기·생물무기의 금지와 특정화학물질·생물작용제 등의 제조·수출입 규제 등에 관한 법률'),
  '29': statute('폐기물의 국가간 이동 및 그 처리에 관한 법률'),
  '30': statute('오존층 보호 등을 위한 특정물질의 관리에 관한 법률'),
  '34': statute('방위사업법'),
  '39': statute('전파법'),
  '41': statute('화학물질관리법'),
  '44': statute('먹는물관리법'),
  '48': statute('산업안전보건법'),
  '53': statute('원자력안전법'),
  '55': statute('총포·도검·화약류 등의 안전관리에 관한 법률'),
  '57': statute('문화유산의 보존 및 활용에 관한 법률'),
  '63': statute('종자산업법'),
  '64': statute('에너지이용 합리화법'),
  '69': statute('마약류 관리에 관한 법률'),
  '70': statute('화장품법'),
  '71': statute('야생생물 보호 및 관리에 관한 법률', '허가'),
  '72': statute('의료기기법'),
  '75': statute('통신비밀보호법'),
  '76': statute('수산생물질병 관리법'),
  '81': statute('석면안전관리법'),
  '85': statute('생물다양성 보전 및 이용에 관한 법률'),
  '86': statute('생활주변방사선 안전관리법'),
  '87': statute('생활화학제품 및 살생물제의 안전관리에 관한 법률'),
  '88': statute('어린이제품 안전 특별법'),
  '89': statute('수입식품안전관리 특별법'),
  '94': statute('위생용품 관리법'),
  '95': statute('목재의 지속가능한 이용에 관한 법률'),
  '96': statute('야생생물 보호 및 관리에 관한 법률', '검역'),
  '97': statute('체외진단의료기기법'),
};

export type AgencyStatus = 'active' | 'renamed' | 'merged';

export interface AgencyEntry {
  /** The agency's current Korean name (may differ from what the API sends). */
  name_ko: string;
  /** Confirmed official English name, or null when none could be confirmed. */
  name_en: string | null;
  /** Page the English name was confirmed on (the agency's own site). */
  source: string | null;
  status: AgencyStatus;
  /** Division the API names in parentheses, e.g. 식물 (plants). Untranslated. */
  division_ko?: string;
  note?: string;
}

const A = (name_ko: string, name_en: string | null, source: string | null, extra: Partial<AgencyEntry> = {}): AgencyEntry => ({
  name_ko,
  name_en,
  source,
  status: 'active',
  ...extra,
});

const MERGED_2026 = {
  status: 'merged' as const,
  note: 'Merged with its neighbour into 전남광주통합특별시 on 2026-07-01; the API still sends the former name. No official English name for the merged government could be confirmed.',
};

/** API approving-agency code (reqApreIttCd) -> agency. */
export const AGENCIES: Record<string, AgencyEntry> = {
  '005': A('식품의약품안전처', 'Ministry of Food and Drug Safety', 'https://www.mfds.go.kr/eng/index.do'),
  '006': A('국가유산청', 'Korea Heritage Service', 'https://www.khs.go.kr/html/HtmlPage.do?pg=/eng/main.jsp'),
  '012': A('농촌진흥청', 'Rural Development Administration', 'https://www.rda.go.kr/main/mainPage.do'),
  '013': A('경찰청', null, null, { note: 'Sources disagree between "Korean National Police Agency" and "National Police Agency"; the agency site could not be read.' }),
  '016': A('고용노동부', 'Ministry of Employment and Labor', 'https://www.moel.go.kr/english/index.jsp', { status: 'renamed', note: 'API sends the pre-2010 name 노동부.' }),
  '017': A('산림청', 'Korea Forest Service', 'https://english.forest.go.kr/'),
  '018': A('서울특별시', 'Seoul Metropolitan Government', 'https://english.seoul.go.kr/'),
  '019': A('부산광역시', 'Busan Metropolitan City', 'https://www.busan.go.kr/index'),
  '020': A('대구광역시', 'Daegu Metropolitan City', 'https://www.daegu.go.kr/english/index.do'),
  '021': A('인천광역시', 'Incheon Metropolitan City', 'https://www.incheon.go.kr/en/index'),
  '022': A('광주광역시', null, null, MERGED_2026),
  '023': A('대전광역시', 'Daejeon Metropolitan City', 'https://www.daejeon.go.kr/english/index.do'),
  '024': A('울산광역시', 'Ulsan Metropolitan City', 'https://www.ulsan.go.kr/u/rep/main.ulsan'),
  '025': A('경기도', 'Gyeonggi Province', 'https://english.gg.go.kr/'),
  '026': A('강원특별자치도', null, null, { status: 'renamed', note: 'API sends the pre-2023 name 강원도. English name not confirmed on the provincial site.' }),
  '027': A('충청북도', 'Chungcheongbuk-do', 'https://www.chungbuk.go.kr/www/index.do'),
  '028': A('충청남도', 'Chungcheongnam-do', 'https://www.chungnam.go.kr/main.do'),
  '029': A('전북특별자치도', 'Jeonbuk State', 'https://www.jeonbuk.go.kr/eng/index.jeonbuk', { status: 'renamed', note: 'API sends the pre-2024 name 전라북도.' }),
  '030': A('전라남도', null, null, MERGED_2026),
  '031': A('경상북도', 'Gyeongsangbuk-do', 'https://www.gb.go.kr/'),
  '032': A('경상남도', 'Gyeongsangnam-do', 'https://www.gyeongnam.go.kr/english/index.gyeong'),
  '033': A('제주특별자치도', 'Jeju Special Self-Governing Province', 'https://www.jeju.go.kr/eng/index.htm', { status: 'renamed', note: 'API sends 제주도.' }),
  '036': A('과학기술정보통신부', 'Ministry of Science and ICT', 'https://www.msit.go.kr/eng/index.do', { status: 'renamed', note: 'API sends the pre-2017 name 미래창조과학부.' }),
  '037': A('산업통상부', 'Ministry of Trade, Industry and Resources', 'https://english.motir.go.kr/'),
  '105': A('국가기술표준원', 'Korean Agency for Technology and Standards', 'https://www.kats.go.kr/en/main.do', { status: 'renamed', note: 'API sends the pre-2013 name 기술표준원.' }),
  '106': A('농림축산검역본부', 'Animal and Plant Quarantine Agency', 'https://www.apqa.go.kr/listindexWebAction.do', { division_ko: '동축산물' }),
  '107': A('농림축산검역본부', 'Animal and Plant Quarantine Agency', 'https://www.apqa.go.kr/listindexWebAction.do', { division_ko: '식물' }),
  '108': A('국립전파연구원', 'National Radio Research Agency', 'https://www.rra.go.kr/en/index.do'),
  '109': A('국립환경과학원', 'National Institute of Environmental Research', 'https://www.nier.go.kr/eng/'),
  '110': A('국립수산물품질관리원', 'National Fishery Products Quality Management Service', 'https://www.nfqs.go.kr/hpmg/'),
  '231': A('농업협동조합중앙회', null, null),
  '243': A('한국의약품수출입협회', 'Korea Pharmaceutical Traders Association', 'https://www.kpta.or.kr/'),
  '250': A('한국산업안전보건공단', null, null, { status: 'renamed', note: 'API sends 한국산업안전공단. English name seen only in secondary sources; the agency page renders by script.' }),
  '253': A('한국가스안전공사', 'Korea Gas Safety Corporation', 'https://www.kgs.or.kr/eng/main.do'),
  '254': A('한국건설생활환경시험연구원', 'Korea Conformity Laboratories', 'https://www.kcl.re.kr/site/main/index001.do'),
  '255': A('FITI시험연구원', 'FITI Testing & Research Institute', 'https://www.fitiglobal.com/en/'),
  '257': A('한국화학융합시험연구원', 'Korea Testing & Research Institute', 'https://ktr.or.kr/eng/introduce/prcenter/contentsid/1092/index.do'),
  '259': A('한국사료협회', null, null),
  '261': A('한국동물약품협회', 'Korea Animal Health Product Association', 'http://www.kahpa.or.kr/eng/'),
  '262': A('한국종자협회', null, null),
  '287': A('한국단미사료협회', null, null),
  '305': A('한국의료기기산업협회', 'Korea Medical Devices Industry Association', 'https://www.kmdia.or.kr/EN/'),
  '314': A('한국산업기술시험원', 'Korea Testing Laboratory', 'https://www.ktl.re.kr/eng/main.do'),
  '315': A('한국기계전기전자시험연구원', null, null, { note: 'English name seen only in secondary sources; the agency page could not be read.' }),
  '321': A('한국완구공업협동조합', null, null),
  '324': A('방위사업청', 'Defense Acquisition Program Administration', 'https://www.dapa.go.kr/dapa_en/main.do'),
  '325': A('KATRI시험연구원', null, null),
  '332': A('유역(지방)환경청', null, null, { note: 'A group of regional offices, not one agency; there is no single official English name.' }),
  '336': A('한국제품안전협회', null, null),
  '339': A('한국의약품시험연구원', 'Korea Pharmaceutical Test & Research Institute', 'https://www.kptr.or.kr', { status: 'renamed', note: 'API sends 한국의약품시험연구소.' }),
  '341': A('(재)충북테크노파크바이오센터', null, null),
  '344': A('(재)한국한방산업진흥원', null, null),
  '345': A('(재)전라남도한방산업진흥원', null, null),
  '346': A('(주)동의한약분석센터', null, null, { note: 'Private company; no English name published.' }),
  '347': A('원자력안전위원회', 'Nuclear Safety and Security Commission', 'https://www.nssc.go.kr/en/index.do'),
  '348': A('한국승강기안전공단', 'Korea Elevator Safety Agency', 'https://www.koelsa.or.kr/'),
  '349': A('대한산업안전협회', 'Korea Industrial Safety Association', 'https://www.safety.or.kr/safety/main/main.do'),
  '350': A('한국방사선안전재단', 'Korea Foundation of Nuclear Safety', 'https://www.kofons.or.kr/web/main/mainPage.do'),
  '423': A('한국환경산업기술원', 'Korea Environmental Industry & Technology Institute', 'https://www.keiti.re.kr/site/eng/main.do'),
  '424': A('한국에너지공단', 'Korea Energy Agency', 'https://www.energy.or.kr/front/main/main.do'),
  '427': A('한국의료기기안전정보원', 'National Institute of Medical Device Safety Information', 'https://www.nids.or.kr/'),
  '429': A('한국석유화학협회', null, null),
  '433': A('국립야생동물질병관리원', null, null),
};

// --- resolution -----------------------------------------------------------------

export type DictMiss =
  | { kind: 'statute'; code: string; matched_by_title: boolean }
  | { kind: 'agency'; code: string };

export interface ResolvedStatute {
  code: string;
  name_ko: string;
  name_en: string | null;
  qualifier_ko?: string;
  law_id?: string;
}

/**
 * By code; failing that, by the Korean title the API sent (all 43 statutes in
 * the notice are known by title, so a new code still gets its English name and
 * is reported for adding). Never translated.
 */
export function resolveStatute(code: string, apiName: string, onMiss?: (m: DictMiss) => void): ResolvedStatute {
  const byCode = STATUTES[code];
  if (byCode) {
    return { code, name_ko: byCode.name_ko, name_en: byCode.name_en, law_id: byCode.law_id, ...(byCode.qualifier_ko ? { qualifier_ko: byCode.qualifier_ko } : {}) };
  }
  const qualifier = /\(([^)]+)\)\s*$/.exec(apiName)?.[1];
  const byTitle = STATUTES_BY_TITLE[normalizeTitle(apiName.replace(/\([^)]*\)\s*$/, ''))];
  onMiss?.({ kind: 'statute', code, matched_by_title: Boolean(byTitle) });
  if (byTitle) {
    return { code, name_ko: byTitle.name_ko, name_en: byTitle.name_en, law_id: byTitle.law_id, ...(qualifier ? { qualifier_ko: qualifier } : {}) };
  }
  return { code, name_ko: apiName, name_en: null };
}

export interface ResolvedAgency {
  code: string;
  name_ko: string;
  name_en: string | null;
  /** Present when the API's Korean name is outdated or the agency has merged. */
  status?: Exclude<AgencyStatus, 'active'>;
  division_ko?: string;
}

/** By code only — agency names are too unstable to match on. Unknown codes keep the API's Korean name. */
export function resolveAgency(code: string, apiName: string, onMiss?: (m: DictMiss) => void): ResolvedAgency {
  const e = AGENCIES[code];
  if (!e) {
    onMiss?.({ kind: 'agency', code });
    return { code, name_ko: apiName, name_en: null };
  }
  return {
    code,
    name_ko: e.name_ko,
    name_en: e.name_en,
    ...(e.status !== 'active' ? { status: e.status } : {}),
    ...(e.division_ko ? { division_ko: e.division_ko } : {}),
  };
}

/**
 * Certificate names (reqCfrmIstmNm) have no codes and, as far as could be
 * established, no official English names: they are domestic form titles.
 * They are returned in Korean only until an official source is found.
 */
export function resolveCertificate(apiName: string): { name_ko: string; name_en: null } {
  return { name_ko: apiName.trim(), name_en: null };
}

/**
 * True when a requirement took effect after the notice revision this
 * dictionary was reviewed against — the notice has been revised since, and
 * new statutes or agencies may have arrived without a code here.
 */
export function reviewDue(aplyStrtDt: string): boolean {
  const iso = /^\d{8}$/.test(aplyStrtDt) ? `${aplyStrtDt.slice(0, 4)}-${aplyStrtDt.slice(4, 6)}-${aplyStrtDt.slice(6)}` : aplyStrtDt;
  return iso > REVIEW.notice_effective;
}
