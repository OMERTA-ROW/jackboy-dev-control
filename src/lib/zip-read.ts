/** Minimal, bounded ZIP reader for one named entry (stored or deflate). Pure; works in workerd and Node.
 * Refuses encryption, ZIP64, duplicate names, size overruns and CRC mismatches, so callers can fail closed. */
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data: Uint8Array, max: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error("ZIP entry is larger than allowed.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function readZipEntry(zip: Uint8Array, name: string, maxBytes: number): Promise<Uint8Array> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive.");
  const count = u16(zip, eocd + 10);
  const cdOffset = u32(zip, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  let at = cdOffset;
  const found: { method: number; flags: number; comp: number; size: number; crc: number; local: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50) throw new Error("ZIP directory is damaged.");
    const nameLen = u16(zip, at + 28);
    const entryName = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (entryName === name) {
      found.push({
        flags: u16(zip, at + 8),
        method: u16(zip, at + 10),
        crc: u32(zip, at + 16),
        comp: u32(zip, at + 20),
        size: u32(zip, at + 24),
        local: u32(zip, at + 42),
      });
    }
    at += 46 + nameLen + u16(zip, at + 30) + u16(zip, at + 32);
  }
  if (found.length !== 1) throw new Error(found.length ? "ZIP entry appears more than once." : "ZIP entry is missing.");
  const e = found[0]!;
  if (e.flags & 1) throw new Error("Encrypted ZIP entries are not supported.");
  if (e.comp === 0xffffffff || e.size === 0xffffffff || e.local === 0xffffffff) throw new Error("ZIP64 entries are not supported.");
  if (e.size > maxBytes) throw new Error("ZIP entry is larger than allowed.");
  if (e.local + 30 > zip.length || u32(zip, e.local) !== 0x04034b50) throw new Error("ZIP entry header is damaged.");
  const start = e.local + 30 + u16(zip, e.local + 26) + u16(zip, e.local + 28);
  if (start + e.comp > zip.length) throw new Error("ZIP entry is truncated.");
  const raw = zip.subarray(start, start + e.comp);
  let data: Uint8Array;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = await inflateRaw(raw, maxBytes);
  else throw new Error("Unsupported ZIP compression.");
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error("ZIP entry failed its integrity check.");
  return data;
}
