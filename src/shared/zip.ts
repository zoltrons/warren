// Reads the files of a ZIP archive (an export such as 1Password's .1pux): stored or deflated entries, found through
// the central directory. Sizes are capped, so an archive cannot inflate past what an import may hold.

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** The named entry's bytes, or undefined when the archive has no such file. */
export async function readZipEntry(zip: Uint8Array, wanted: (name: string) => boolean, maxBytes: number): Promise<Uint8Array | undefined> {
  // End of central directory: the last "PK\5\6" within the final 64 KiB + 22 bytes.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--)
    if (u32(zip, i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("This is not a ZIP archive");
  let at = u32(zip, end + 16);
  for (let n = u16(zip, end + 10); n > 0; n--) {
    if (u32(zip, at) !== 0x02014b50) throw new Error("The ZIP archive is damaged");
    const method = u16(zip, at + 10);
    const packed = u32(zip, at + 20);
    const size = u32(zip, at + 24);
    const nameLen = u16(zip, at + 28);
    const next = at + 46 + nameLen + u16(zip, at + 30) + u16(zip, at + 32);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (wanted(name)) {
      if (size > maxBytes) throw new Error("The file in the archive is too large");
      const local = u32(zip, at + 42);
      if (u32(zip, local) !== 0x04034b50) throw new Error("The ZIP archive is damaged");
      const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
      const data = zip.subarray(start, start + packed);
      if (method === 0) return data;
      if (method !== 8) throw new Error("The ZIP archive uses a compression Warren cannot read");
      return inflate(data, maxBytes);
    }
    at = next;
  }
  return undefined;
}

async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    total += r.value.length;
    // The central directory's size may lie: the stream itself is what is capped.
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The file in the archive is too large");
    }
    parts.push(r.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) out.set(p, (off += p.length) - p.length);
  return out;
}
