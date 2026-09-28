/**
 * Regression test for the guard that decides whether a job entry point runs.
 *
 * The hand-rolled predecessor of isMainModule matched on Windows and failed
 * on Linux, so both Cloud Run Jobs started, skipped their own bodies and
 * exited 0 — success reported, nothing done. These cases pin the POSIX shape
 * that broke, so the bug cannot come back unnoticed.
 */

import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../src/is-main.js';

describe('isMainModule', () => {
  it('agrees with the platform on what a script path means', () => {
    // The real comparison a job makes: its own module URL against argv[1].
    for (const argv1 of ['/app/dist/index-build-job.js', 'dist/job.js']) {
      expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
    }
  });

  it('documents the bug: the old hand-rolled URL was wrong on Linux', () => {
    // On Linux argv[1] is already absolute, so prefixing "file:///" produced a
    // fourth slash and the guard never matched — the job exited 0 doing
    // nothing. Asserted as a plain string so it holds on any platform.
    const posixArgv1 = '/app/dist/index-build-job.js';
    expect(`file:///${posixArgv1}`).toBe('file:////app/dist/index-build-job.js');
    expect(`file:///${posixArgv1}`).not.toBe('file:///app/dist/index-build-job.js');
  });

  it('does not match a different module', () => {
    expect(isMainModule('file:///app/dist/other.js', '/app/dist/job.js')).toBe(false);
  });

  it('is false when there is no script argument', () => {
    expect(isMainModule('file:///app/dist/job.js', undefined)).toBe(false);
  });
});
