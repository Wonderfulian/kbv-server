/**
 * The 2026-10-23 incident as a decision table. The case that matters most is
 * the one where the guard must NOT exit: customs and NTS both unreachable is
 * an upstream or network problem, and exiting would take every instance down
 * in turn.
 */

import { describe, expect, it } from 'vitest';
import { createEgressGuard, probeHost, type EgressGuardOptions } from '../src/egress-guard.js';
import { createCustomsClient } from '../src/customs.js';

function guard(over: Partial<EgressGuardOptions> = {}) {
  const logs: Record<string, unknown>[] = [];
  const state = { exits: 0, probes: 0, claims: 0 };
  const g = createEgressGuard({
    threshold: 3,
    minUptimeMs: 600_000,
    probeCustoms: async () => (state.probes++, false),
    probeNts: async () => true,
    claimExit: async () => (state.claims++, true),
    uptimeMs: () => 3_600_000,
    log: (l) => logs.push(l),
    terminate: () => state.exits++,
    ...over,
  });
  return { g, logs, state };
}

const fail = (g: ReturnType<typeof guard>['g'], n: number) => {
  for (let i = 0; i < n; i++) g.record(false, 'network');
};

describe('egress guard', () => {
  it('customs unreachable, NTS reachable: this instance is broken — one ERROR line, then exit', async () => {
    const { g, logs, state } = guard();
    fail(g, 3);
    await g.idle();
    expect(state.exits).toBe(1);
    expect(logs.at(-1)).toMatchObject({
      severity: 'ERROR',
      event: 'instance_self_terminate',
      customs_reachable: false,
      nts_reachable: true,
      customs_network_failures: 3,
    });
  });

  it('customs and NTS both unreachable: upstream or network — stays up, WARNING only', async () => {
    const { g, logs, state } = guard({ probeNts: async () => false });
    fail(g, 10);
    await g.idle();
    expect(state.exits).toBe(0);
    expect(state.claims).toBe(0);
    expect(logs.every((l) => l.event === 'egress_check' && l.verdict === 'upstream_or_network' && l.severity === 'WARNING')).toBe(true);
  });

  it('customs reachable again when probed: transient, nothing happens', async () => {
    const { g, logs, state } = guard({ probeCustoms: async () => true });
    fail(g, 3);
    await g.idle();
    expect(state.exits).toBe(0);
    expect(logs[0]).toMatchObject({ verdict: 'transient' });
  });

  it('counts only failures with no HTTP response; an upstream error or a success resets the run', async () => {
    const { g, state } = guard();
    fail(g, 2);
    g.record(false, 'upstream'); // the host answered (5xx, bad result code): it was reachable
    fail(g, 2);
    g.record(true);
    fail(g, 2);
    await g.idle();
    expect(state.probes).toBe(0);
  });

  it('does not exit before the minimum uptime — and does once it has passed', async () => {
    let uptime = 60_000;
    const { g, logs, state } = guard({ uptimeMs: () => uptime });
    fail(g, 3);
    await g.idle();
    expect(state.exits).toBe(0);
    expect(logs.at(-1)).toMatchObject({ verdict: 'instance_suspect', held_by: 'min_uptime' });
    uptime = 700_000;
    fail(g, 1);
    await g.idle();
    expect(state.exits).toBe(1);
  });

  it('respects the fleet-wide exit limit, and treats an unreadable limit as "no"', async () => {
    const limited = guard({ claimExit: async () => false });
    fail(limited.g, 3);
    await limited.g.idle();
    expect(limited.state.exits).toBe(0);
    expect(limited.logs.at(-1)).toMatchObject({ held_by: 'exit_rate_limit' });

    const broken = guard({
      claimExit: async () => {
        throw new Error('bucket unreachable');
      },
    });
    fail(broken.g, 3);
    await broken.g.idle();
    expect(broken.state.exits).toBe(0);
  });

  it('runs one diagnosis at a time and exits at most once', async () => {
    const { g, state } = guard();
    fail(g, 20);
    await g.idle();
    fail(g, 5);
    await g.idle();
    expect(state.exits).toBe(1);
  });
});

describe('customs client failure kinds', () => {
  const client = (fetchFn: typeof fetch, seen: unknown[]) =>
    createCustomsClient({ serviceKey: 'k', fetchFn, retry: { retries: 0 }, onLatency: (_ms, ok, failure) => seen.push([ok, failure]) });

  it('reports "network" when no response came back, "upstream" when the host answered with an error', async () => {
    const seen: unknown[] = [];
    await expect(client(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), seen).requirements('8516710000', 'import')).rejects.toThrow();
    await expect(client(async () => new Response('', { status: 502 }), seen).requirements('8516710000', 'import')).rejects.toThrow();
    expect(seen).toEqual([
      [false, 'network'],
      [false, 'upstream'],
    ]);
  });
});

describe('probeHost', () => {
  it('counts any HTTP answer as reachable, and only a failed connection as not', async () => {
    expect(await probeHost('https://x', 1000, async () => new Response('', { status: 401 }))).toBe(true);
    expect(await probeHost('https://x', 1000, async () => Promise.reject(new TypeError('fetch failed')))).toBe(false);
  });
});
