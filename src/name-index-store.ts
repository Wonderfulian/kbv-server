/**
 * Persistence for the name index (see name-index.ts). One JSONL file —
 * `index/name-index.jsonl` — small enough (≈120k identity rows) to load into
 * the server's memory at boot and cheap enough to rewrite whole on each build.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import type { NameIndexEntry } from './name-index.js';

export const INDEX_PATH = 'index/name-index.jsonl';

export interface NameIndexStore {
  read(): Promise<NameIndexEntry[]>;
  write(entries: NameIndexEntry[]): Promise<void>;
}

function toJsonl(entries: NameIndexEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

function fromJsonl(text: string): NameIndexEntry[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as NameIndexEntry);
}

export class GcsNameIndexStore implements NameIndexStore {
  private readonly bucket;

  constructor(bucketName: string, storage = new Storage()) {
    this.bucket = storage.bucket(bucketName);
  }

  async read(): Promise<NameIndexEntry[]> {
    const file = this.bucket.file(INDEX_PATH);
    const [exists] = await file.exists();
    if (!exists) return [];
    const [buf] = await file.download();
    return fromJsonl(buf.toString('utf8'));
  }

  async write(entries: NameIndexEntry[]): Promise<void> {
    await this.bucket.file(INDEX_PATH).save(toJsonl(entries), { contentType: 'application/x-ndjson' });
  }
}

export class LocalNameIndexStore implements NameIndexStore {
  constructor(private readonly root: string) {}

  async read(): Promise<NameIndexEntry[]> {
    try {
      return fromJsonl(await readFile(join(this.root, INDEX_PATH), 'utf8'));
    } catch {
      return [];
    }
  }

  async write(entries: NameIndexEntry[]): Promise<void> {
    const path = join(this.root, INDEX_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, toJsonl(entries), 'utf8');
  }
}
