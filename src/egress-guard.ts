/**
 * Self-healing for an instance that has lost its route to one upstream host.
 *
 * Observed 2026-10-23, revision 00025: right after a deploy, one instance
 * could no longer connect to the customs API host (every call a 10 s connect
 * timeout, three attempts each) and answered 503 for its whole life. The NTS
 * API worked from the same instance, and a Cloud Run Job reached the customs
 * host in 0.17 s. A new instance fixed it at once.
 *
 * This module repeats that diagnosis in code. After a run of consecutive
 * NETWORK failures (no HTTP response at all — an upstream that answers with an
 * error was reachable, and resets the run), it probes both hosts without a key:
 *
 *   customs reachable          → transient; carry on
 *   customs ✗, NTS ✓           → this instance's egress is broken → exit, and
 *                                Cloud Run starts a replacement
 *   customs ✗, NTS ✗           → upstream or network trouble, not this
 *                                instance → stay up, 503s, WARNING log
 *
 * The distinction is the whole point: exiting on customs failures alone would
 * have every instance kill itself in turn during an upstream outage.
 *
 * Safeguards: no exit before a minimum uptime (a fresh instance is not judged
 * on its first calls); at most one exit per interval across all instances (a
 * shared marker in the bucket — if it cannot be read or written, no exit);
 * one ERROR line with the evidence before exiting.
 */

export interface EgressGuardOptions {
  /** Consecutive network failures before the probes run. */
  threshold: number;
  /** No self-exit before this much uptime. */
  minUptimeMs: number;
  /** Keyless probes: resolve true when the host returned any HTTP response. */
  probeCustoms: () => Promise<boolean>;
  probeNts: () => Promise<boolean>;
  /** Fleet-wide rate limit: true = this instance may exit now (and the claim is recorded). */
  claimExit: () => Promise<boolean>;
  uptimeMs: () => number;
  log: (info: Record<string, unknown>) => void;
  terminate: () => void;
}

export interface EgressGuard {
  /** Feed every customs call outcome. */
  record(ok: boolean, failure?: 'network' | 'upstream'): void;
  /** For tests: resolves when any diagnosis in progress has finished. */
  idle(): Promise<void>;
}

export function createEgressGuard(opts: EgressGuardOptions): EgressGuard {
  let streak = 0;
  let running: Promise<void> | undefined;
  let terminating = false;

  async function diagnose(): Promise<void> {
    const [customs, nts] = await Promise.all([opts.probeCustoms().catch(() => false), opts.probeNts().catch(() => false)]);
    const evidence = { customs_network_failures: streak, customs_reachable: customs, nts_reachable: nts, uptime_s: Math.round(opts.uptimeMs() / 1000) };
    if (customs) {
      opts.log({ severity: 'INFO', event: 'egress_check', verdict: 'transient', ...evidence });
      streak = 0;
      return;
    }
    if (!nts) {
      // Both unreachable: not this instance. Staying up is right; restarting would not help.
      opts.log({ severity: 'WARNING', event: 'egress_check', verdict: 'upstream_or_network', ...evidence });
      streak = 0; // look again after another full run of failures
      return;
    }
    if (opts.uptimeMs() < opts.minUptimeMs) {
      opts.log({ severity: 'WARNING', event: 'egress_check', verdict: 'instance_suspect', held_by: 'min_uptime', ...evidence });
      return;
    }
    let allowed = false;
    try {
      allowed = await opts.claimExit();
    } catch {
      allowed = false;
    }
    if (!allowed) {
      opts.log({ severity: 'WARNING', event: 'egress_check', verdict: 'instance_suspect', held_by: 'exit_rate_limit', ...evidence });
      return;
    }
    terminating = true;
    opts.log({ severity: 'ERROR', event: 'instance_self_terminate', verdict: 'instance_egress_broken', ...evidence });
    opts.terminate();
  }

  return {
    record(ok, failure) {
      if (terminating) return;
      if (ok || failure !== 'network') {
        streak = 0;
        return;
      }
      streak++;
      if (streak >= opts.threshold && !running) {
        running = diagnose().finally(() => {
          running = undefined;
        });
      }
    },
    async idle() {
      await running;
    },
  };
}

/** Any HTTP response within the timeout counts as reachable — the probe carries no key. */
export async function probeHost(url: string, timeoutMs = 5_000, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
