import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import type { Readable } from "node:stream";

/**
 * A zip made on the spot for one check: the checker program, its rules, and a small check.json holding that check's code, so the
 * player does not have to type it. Files are STORED (not compressed): the zip is written in one pass from disk and never held in
 * memory, and the program is already one big file. The checksum of the program is worked out once and kept.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export type ZipSource =
  | { name: string; data: Buffer }
  | { name: string; path: string; size: number; crc: number };

const DOS_TIME = 0;
// 2026-01-01, the date every file in the zip carries.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function localHeader(name: Buffer, crc: number, size: number) {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // names are UTF-8
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function centralHeader(name: Buffer, crc: number, size: number, offset: number) {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

function endRecord(entries: number, centralSize: number, centralOffset: number) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return end;
}

const sizeOf = (source: ZipSource) => ("data" in source ? source.data.length : source.size);
const crcOf = (source: ZipSource) => ("data" in source ? crc32(source.data) : source.crc);

/** How many bytes the finished zip has, so the download can show progress. */
export function zipLength(sources: ZipSource[]): number {
  let total = 22;
  for (const source of sources) {
    const name = Buffer.byteLength(source.name);
    total += 30 + name + sizeOf(source) + 46 + name;
  }
  return total;
}

/** The zip, chunk by chunk, in the order: each file's header and bytes, then the directory at the end. */
export async function* zipChunks(sources: ZipSource[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const source of sources) {
    const name = Buffer.from(source.name, "utf8");
    const size = sizeOf(source);
    const crc = crcOf(source);
    const header = localHeader(name, crc, size);
    central.push(centralHeader(name, crc, size, offset));
    yield header;
    offset += header.length;
    if ("data" in source) yield source.data;
    else for await (const chunk of createReadStream(source.path) as Readable) yield chunk as Buffer;
    offset += size;
  }
  const directory = Buffer.concat(central);
  yield directory;
  yield endRecord(sources.length, directory.length, offset);
}

type FileInfo = { path: string; size: number; crc: number; sha256: string; mtimeMs: number };
const known = new Map<string, FileInfo>();

/** The size and checksum of a big file, worked out once and again only when the file changes. */
export async function fileInfo(path: string): Promise<FileInfo | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return null;
    const cached = known.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    let crc = 0;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path) as Readable) {
      crc = crc32(chunk as Buffer, crc);
      hash.update(chunk as Buffer);
    }
    const info = { path, size: stat.size, crc, sha256: hash.digest("hex"), mtimeMs: stat.mtimeMs };
    known.set(path, info);
    return info;
  } catch {
    return null;
  }
}

/**
 * The checker as set up on this server: CHECKER_EXE_PATH is the signed LegacyX-Checker.exe, CHECKER_RULES_PATH (optional) its
 * rules.json. Null when no program is set up, so the site does not promise a download it cannot give.
 */
/** The SHA-256 of the checker program on this server, shown to staff so a player can compare it with what they downloaded. */
export async function checkerSha256(): Promise<string | null> {
  const msi = await checkerMsi();
  if (msi) return msi.sha256;
  const exePath = process.env.CHECKER_EXE_PATH?.trim();
  return exePath ? (await fileInfo(exePath))?.sha256 ?? null : null;
}

/** The installer (LegacyX-Checker.msi) when CHECKER_MSI_PATH is set: it is sent as it is, with no code inside; the player types the code. */
export async function checkerMsi() {
  const msiPath = process.env.CHECKER_MSI_PATH?.trim();
  return msiPath ? fileInfo(msiPath) : null;
}

export async function checkerBase(): Promise<ZipSource[] | null> {
  const exePath = process.env.CHECKER_EXE_PATH?.trim();
  if (!exePath) return null;
  const exe = await fileInfo(exePath);
  if (!exe) return null;
  const sources: ZipSource[] = [{ name: "LegacyX-Checker.exe", path: exe.path, size: exe.size, crc: exe.crc }];
  const rulesPath = process.env.CHECKER_RULES_PATH?.trim();
  const rules = rulesPath ? await fileInfo(rulesPath) : null;
  if (rules) sources.push({ name: "rules.json", path: rules.path, size: rules.size, crc: rules.crc });
  return sources;
}
