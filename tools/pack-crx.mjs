// CRX3 packer and verifier on node:crypto alone, so the release job that holds CRX_KEY runs no npm package and no
// browser. Format: components/crx_file/crx3.proto in Chromium.
//   node tools/pack-crx.mjs <ext.zip> <key.pem> <out.crx>   signs the zip, prints the extension id
//   node tools/pack-crx.mjs --verify <file.crx>              checks the signature, prints the extension id
import { createPrivateKey, createPublicKey, createHash, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("Cr24");
const SIGN_CONTEXT = Buffer.from("CRX3 SignedData\x00");

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

// ---------- protobuf: only what CrxFileHeader needs (length-delimited fields) ----------

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
const field = (no, bytes) => Buffer.concat([varint((no << 3) | 2), varint(bytes.length), bytes]);

function readFields(buf) {
  const fields = [];
  let i = 0;
  const readVarint = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= buf.length || shift > 28) throw new Error("bad varint");
      const b = buf[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
    }
  };
  while (i < buf.length) {
    const tag = readVarint();
    if ((tag & 7) !== 2) throw new Error(`unexpected wire type ${tag & 7}`);
    const len = readVarint();
    if (i + len > buf.length) throw new Error("truncated field");
    fields.push([tag >>> 3, buf.subarray(i, i + len)]);
    i += len;
  }
  return fields;
}

// ---------- CRX3 ----------

/** First 128 bits of SHA-256 over the SubjectPublicKeyInfo: the CRX id, and the extension id written with a-p. */
const crxId = (spki) => createHash("sha256").update(spki).digest().subarray(0, 16);
const extensionId = (id) => [...id.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const signedPayload = (signedHeaderData, zip) => Buffer.concat([SIGN_CONTEXT, u32(signedHeaderData.length), signedHeaderData, zip]);

export function pack(zip, pem) {
  const key = createPrivateKey(pem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const id = crxId(spki);
  const signedHeaderData = field(1, id); // SignedData { crx_id }
  const signature = sign("sha256", signedPayload(signedHeaderData, zip), key); // RSASSA-PKCS1-v1_5
  const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, signature)])), field(10000, signedHeaderData)]);
  return { crx: Buffer.concat([MAGIC, u32(3), u32(header.length), header, zip]), id: extensionId(id) };
}

/** Throws unless `crx` is a CRX3 whose RSA proof for its own id verifies; returns the extension id. */
export function check(crx) {
  if (!crx.subarray(0, 4).equals(MAGIC) || crx.readUInt32LE(4) !== 3) throw new Error("not a CRX3 file");
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const zip = crx.subarray(12 + headerLen);
  const fields = readFields(header);
  const signedHeaderData = fields.find(([no]) => no === 10000)?.[1];
  if (!signedHeaderData) throw new Error("no signed header data");
  const id = readFields(signedHeaderData).find(([no]) => no === 1)?.[1];
  if (!id || id.length !== 16) throw new Error("no crx id");
  for (const [no, proof] of fields) {
    if (no !== 2) continue;
    const parts = new Map(readFields(proof));
    const spki = parts.get(1);
    const signature = parts.get(2);
    if (!spki || !signature || !crxId(spki).equals(id)) continue;
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (verify("sha256", signedPayload(signedHeaderData, zip), publicKey, signature)) return extensionId(id);
    throw new Error("signature does not verify");
  }
  throw new Error("no RSA proof for the crx id");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b, c] = process.argv.slice(2);
  if (a === "--verify" && b) console.log(check(readFileSync(b)));
  else if (a && b && c) {
    const { crx, id } = pack(readFileSync(a), readFileSync(b));
    check(crx); // never publish a file we could not read back
    writeFileSync(c, crx);
    console.log(id);
  } else {
    console.error("usage: pack-crx.mjs <ext.zip> <key.pem> <out.crx> | --verify <file.crx>");
    process.exit(2);
  }
}
