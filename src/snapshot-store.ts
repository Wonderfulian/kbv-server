/**
 * Storage backends for the daily snapshot (see snapshot.ts for the corpus
 * policy). Files are newline-delimited JSON so a day can be appended to a
 * data warehouse, diffed with shell tools, or handed to a buyer as-is:
 *
 *   corpus/current.jsonl      the public-list numbers in scope
 *   status/YYYY-MM-DD.jsonl   one row per business observed that day
 *   changes/YYYY-MM-DD.jsonl  transitions detected that day (with evidence)
 *
 * GCS is the production backend; the local one exists so a dry run can be
 * inspected on disk before the job ever touches a bucket.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import type { ChangeRecord, CorpusEntry, SnapshotRecord, SnapshotStore } from './snapshot.js';

const CORPUS_PATH = 'corpus/current.jsonl';
const STATUS_PREFIX = 'status/';
const CHANGES_PREFIX = 'changes/';
const DATE_FROM_NAME = /(\d{4}-\d{2}-\d{2})\.jsonl$/;

function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

function fromJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** Newest snapshot date strictly before `date`, from a list of object names. */
function latestDateBefore(names: string[], date: string): string | null {
  const dates = names
    .map((name) => DATE_FROM_NAME.exec(name)?.[1])
    .filter((d): d is string => Boolean(d) && (d as string) < date)
    .sort();
  return dates.at(-1) ?? null;
}

export class GcsSnapshotStore implements SnapshotStore {
  private readonly bucket;

  constructor(bucketName: string, storage = new Storage()) {
    this.bucket = storage.bucket(bucketName);
  }

  async readCorpus(): Promise<CorpusEntry[]> {
    const [exists] = await this.bucket.file(CORPUS_PATH).exists();
    if (!exists) return [];
    const [buf] = await this.bucket.file(CORPUS_PATH).download();
    return fromJsonl<CorpusEntry>(buf.toString('utf8'));
  }

  async readLatestSnapshotBefore(date: string): Promise<{ date: string; records: SnapshotRecord[] } | null> {
    const [files] = await this.bucket.getFiles({ prefix: STATUS_PREFIX });
    const previous = latestDateBefore(
      files.map((f) => f.name),
      date,
    );
    if (!previous) return null;
    const [buf] = await this.bucket.file(`${STATUS_PREFIX}${previous}.jsonl`).download();
    return { date: previous, records: fromJsonl<SnapshotRecord>(buf.toString('utf8')) };
  }

  async writeSnapshot(date: string, records: SnapshotRecord[]): Promise<void> {
    await this.bucket.file(`${STATUS_PREFIX}${date}.jsonl`).save(toJsonl(records), {
      contentType: 'application/x-ndjson',
    });
  }

  async writeChanges(date: string, changes: ChangeRecord[]): Promise<void> {
    await this.bucket.file(`${CHANGES_PREFIX}${date}.jsonl`).save(toJsonl(changes), {
      contentType: 'application/x-ndjson',
    });
  }
}

/** Same layout on the local filesystem — for dry runs and manual inspection. */
export class LocalSnapshotStore implements SnapshotStore {
  constructor(private readonly root: string) {}

  private async write(relative: string, body: string): Promise<void> {
    const path = join(this.root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
  }

  async readCorpus(): Promise<CorpusEntry[]> {
    try {
      return fromJsonl<CorpusEntry>(await readFile(join(this.root, CORPUS_PATH), 'utf8'));
    } catch {
      return [];
    }
  }

  async readLatestSnapshotBefore(date: string): Promise<{ date: string; records: SnapshotRecord[] } | null> {
    let names: string[];
    try {
      names = await readdir(join(this.root, STATUS_PREFIX));
    } catch {
      return null;
    }
    const previous = latestDateBefore(names, date);
    if (!previous) return null;
    const text = await readFile(join(this.root, STATUS_PREFIX, `${previous}.jsonl`), 'utf8');
    return { date: previous, records: fromJsonl<SnapshotRecord>(text) };
  }

  async writeSnapshot(date: string, records: SnapshotRecord[]): Promise<void> {
    await this.write(`${STATUS_PREFIX}${date}.jsonl`, toJsonl(records));
  }

  async writeChanges(date: string, changes: ChangeRecord[]): Promise<void> {
    await this.write(`${CHANGES_PREFIX}${date}.jsonl`, toJsonl(changes));
  }
}
