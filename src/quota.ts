/**
 * Free-tier quota: N lookup units per client IP per UTC day, shared by every
 * entry point (REST and MCP) so neither channel can be used to bypass the
 * other's limit. Units mirror pricing: status = 1, verify = 1, batch = one
 * per number.
 *
 * In-memory and per-instance by design (pilot scale, Cloud Run max 2
 * instances → worst case the free tier is 2x the configured limit).
 * IPs are used only as counter keys and are never logged.
 */

const SWEEP_THRESHOLD = 10_000;

export interface Quota {
  /** Consume `units` for `ip`; false when the daily limit would be exceeded. */
  tryConsume(ip: string, units: number): boolean;
}

export function createQuota(dailyLimit: number, now: () => Date = () => new Date()): Quota {
  const used = new Map<string, { day: string; units: number }>();

  function sweep(today: string): void {
    if (used.size < SWEEP_THRESHOLD) return;
    for (const [key, entry] of used) {
      if (entry.day !== today) used.delete(key);
    }
  }

  return {
    tryConsume(ip, units) {
      const today = now().toISOString().slice(0, 10);
      sweep(today);
      const entry = used.get(ip);
      const current = entry && entry.day === today ? entry.units : 0;
      if (current + units > dailyLimit) return false;
      used.set(ip, { day: today, units: current + units });
      return true;
    },
  };
}
