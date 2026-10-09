import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, fileInfo, zipChunks, zipLength } from "./checkerZip";

async function collect(chunks: AsyncGenerator<Buffer>) {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

/** A tiny reader: finds the files in a zip the way an unzip program does, through the directory at the end. */
function read(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, { data: Buffer; crc: number }> = {};
  for (let index = 0; index < entries; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    files[name] = { data: zip.subarray(local, local + size), crc };
    at += 46 + nameLength;
  }
  return files;
}

describe("checker zip", () => {
  it("has the known checksum of a string", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf43926);
  });

  it("holds a program from disk and a small file made on the spot, and says its own length", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lx-zip-"));
    const path = join(directory, "program.exe");
    const program = Buffer.from("MZ" + "x".repeat(200_000));
    writeFileSync(path, program);
    const info = await fileInfo(path);
    expect(info).not.toBeNull();
    const sources = [
      { name: "LegacyX-Checker.exe", path, size: info!.size, crc: info!.crc },
      { name: "check.json", data: Buffer.from(JSON.stringify({ code: "K7F2-9QX4" })) },
    ];
    const zip = await collect(zipChunks(sources));
    expect(zip.length).toBe(zipLength(sources));
    const files = read(zip);
    expect(Object.keys(files)).toEqual(["LegacyX-Checker.exe", "check.json"]);
    expect(files["LegacyX-Checker.exe"].data.equals(program)).toBe(true);
    expect(crc32(files["LegacyX-Checker.exe"].data)).toBe(files["LegacyX-Checker.exe"].crc);
    expect(JSON.parse(files["check.json"].data.toString())).toEqual({ code: "K7F2-9QX4" });
  });

  it("has no checksum for a file that is not there", async () => {
    expect(await fileInfo("/nonexistent/file.exe")).toBeNull();
  });
});
