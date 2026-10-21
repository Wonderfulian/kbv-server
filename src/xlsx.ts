/**
 * Minimal XLSX reader: first worksheet as rows of strings.
 *
 * The Korea Customs Service publishes its HS master and tariff tables only
 * as XLSX, once a year. An XLSX file is a ZIP of XML parts, so — as with
 * DART's corpCode ZIP — reading the central directory ourselves beats adding
 * a spreadsheet library for one file a year. Handles shared strings, inline
 * strings and plain values; ignores styles and formulas (the sources have
 * none we need).
 */

import { inflateRawSync } from 'node:zlib';

export class XlsxError extends Error {}

/** Every member of a ZIP archive, by name. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = zip.lastIndexOf(eocdSig);
  if (eocd < 0) throw new XlsxError('not a ZIP archive (no end-of-central-directory record)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('corrupt ZIP central directory');
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new XlsxError(`corrupt ZIP local header for ${name}`);
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new XlsxError(`unsupported ZIP compression method ${method} for ${name}`);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
    e.startsWith('#x')
      ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith('#')
        ? String.fromCodePoint(Number(e.slice(1)))
        : (ENTITIES[e] ?? _m),
  );
}

/** Concatenated text of every <t> run inside a fragment (rich text has several). */
function textRuns(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Rows of the first worksheet; missing cells are empty strings. */
export function readFirstSheet(xlsx: Buffer): string[][] {
  const sheets = readSheets(xlsx);
  const first = sheets.values().next();
  if (first.done) throw new XlsxError('workbook has no worksheet');
  return first.value;
}

/**
 * Every worksheet by its tab name, in workbook order. Tab order comes from
 * xl/workbook.xml and its relationships — the sheetN.xml numbering need not
 * match it.
 */
export function readSheets(xlsx: Buffer): Map<string, string[][]> {
  const parts = readZip(xlsx);
  const shared: string[] = [];
  const sst = parts.get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));

  const wb = parts.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const ordered: [string, string][] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/\bname="([^"]+)"/.exec(m[0])?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const t = rid ? target.get(rid) : undefined;
    if (t) ordered.push([name, `xl/${t}`]);
  }
  if (ordered.length === 0) {
    // No workbook.xml (minimal files): fall back to sheetN numbering.
    for (const n of [...parts.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]))) {
      ordered.push([n.replace(/^.*\/|\.xml$/g, ''), n]);
    }
  }
  const out = new Map<string, string[][]>();
  for (const [name, path] of ordered) {
    const xml = parts.get(path);
    if (xml) out.set(name, parseSheet(xml.toString('utf8'), shared));
  }
  return out;
}

function parseSheet(sheet: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textRuns(body);
      else if (v !== undefined) value = decodeXml(v);
      const col = ref ? columnIndex(ref) : row.length;
      while (row.length < col) row.push('');
      row[col] = value;
    }
    rows.push(row);
  }
  return rows;
}
