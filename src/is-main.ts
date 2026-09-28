/**
 * "Am I the script that was run?" — the guard our job entry points use.
 *
 * The hand-rolled version of this check (`file:///${argv[1]}`) worked on
 * Windows and failed silently on Linux, where argv[1] is already absolute:
 * it produced `file:////app/dist/job.js` against an actual module URL of
 * `file:///app/dist/job.js`. The job started, matched nothing, and exited 0 —
 * a Cloud Run Job that reported success while doing nothing at all.
 *
 * pathToFileURL does the platform-correct thing; never rebuild this by hand.
 */

import { pathToFileURL } from 'node:url';

export function isMainModule(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}
