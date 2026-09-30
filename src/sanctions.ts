/**
 * Debarment ("부정당업자 제재") lookup for batch screening.
 *
 * The batch endpoint already answers "are these 100 companies still
 * operating?". Attaching debarments answers the question a procurement team
 * actually has: "should we be dealing with any of them?" A company can be
 * perfectly active and still barred from public contracts.
 *
 * Two distinctions the response has to make explicitly, because an agent
 * cannot infer either one:
 *   - `sanctions: []` means we checked and found none. The field being absent
 *     means this server has no debarment data loaded — not the same thing.
 *   - `active` separates a debarment in force today from one that has expired.
 *     Both are worth knowing; conflating them would either cry wolf or hide
 *     history.
 *
 * Source: Public Procurement Service, company-level only — the upstream
 * exposes no representative name here, and we would drop it if it did.
 */

/** One debarment, as published. */
export interface SanctionRecord {
  business_number: string;
  name: string;
  /** ISO dates (YYYY-MM-DD) as published. */
  begins_on?: string;
  ends_on?: string;
  institution?: string;
  law?: string;
  /** Disposition state, e.g. 처분확정 / 집행정지. */
  status?: string;
}

/** What the collector writes to sanctions/current.json. */
export interface SanctionsFile {
  updated_at: string;
  sanctions: SanctionRecord[];
}

/** A debarment as served: the published record plus whether it bites today. */
export interface SanctionView extends SanctionRecord {
  /** True when today falls inside [begins_on, ends_on]. */
  active: boolean;
}

export type SanctionsLookup = (numbers: string[]) => Promise<Map<string, SanctionView[]>>;

/** Inclusive date-window test; an absent bound is treated as open-ended. */
export function isActiveOn(record: SanctionRecord, today: string): boolean {
  if (record.begins_on && today < record.begins_on) return false;
  if (record.ends_on && today > record.ends_on) return false;
  return true;
}

/** Groups records by business number, newest window first. */
export function indexSanctions(records: SanctionRecord[]): Map<string, SanctionRecord[]> {
  const byNumber = new Map<string, SanctionRecord[]>();
  for (const record of records) {
    const list = byNumber.get(record.business_number);
    if (list) list.push(record);
    else byNumber.set(record.business_number, [record]);
  }
  for (const list of byNumber.values()) {
    list.sort((a, b) => (b.begins_on ?? '').localeCompare(a.begins_on ?? ''));
  }
  return byNumber;
}

/**
 * Builds a lookup that loads the file once per process. The list is small
 * (hundreds of rows), so it is held whole rather than queried per request.
 */
export function createSanctionsLookup(
  load: () => Promise<SanctionsFile | null>,
  now: () => Date = () => new Date(),
): SanctionsLookup {
  let pending: Promise<Map<string, SanctionRecord[]>> | null = null;

  const index = (): Promise<Map<string, SanctionRecord[]>> => {
    pending ??= load()
      .then((file) => indexSanctions(file?.sanctions ?? []))
      .catch((err) => {
        pending = null; // a failed load must not be cached forever
        throw err;
      });
    return pending;
  };

  return async (numbers) => {
    const byNumber = await index();
    const today = now().toISOString().slice(0, 10);
    const out = new Map<string, SanctionView[]>();
    for (const number of numbers) {
      const records = byNumber.get(number);
      // Every requested number gets an entry — an empty array is the answer
      // "screened, nothing found", which is what a screening tool must say.
      out.set(
        number,
        (records ?? []).map((record) => ({ ...record, active: isActiveOn(record, today) })),
      );
    }
    return out;
  };
}
