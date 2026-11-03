// Text encrypted with the user key for our own storage, padded first (like the official clients' padded data
// packer): a ciphertext's length then tells neither a password's or PIN's length nor how big a record is.
import { coreCall } from "./core.ts";
import { getLocal, setLocal } from "./store.ts";

/** Marks padded plaintext. Never part of a real value, so older unpadded values read back unchanged. */
const MARK = "\u0000";

/** `text` as JSON with every non-ASCII character escaped (so characters are bytes), padded to whole blocks. */
export function pad(text: string, block: number): string {
  const body = MARK + JSON.stringify(text).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return body.padEnd(Math.ceil(body.length / block) * block, " ");
}

/** The original text; a value written before padding comes back as it is. */
export function unpad(v: string): string {
  if (!v.startsWith(MARK)) return v;
  try {
    const x: unknown = JSON.parse(v.slice(1));
    return typeof x === "string" ? x : "";
  } catch {
    return "";
  }
}

/** Was this (decrypted) value written padded? */
export const isPadded = (v: string): boolean => v.startsWith(MARK);

export const seal = async (values: string[], block: number): Promise<string[]> =>
  coreCall<string[]>({ op: "encryptText", values: values.map((v) => pad(v, block)) });

/** Decrypts and unpads; a value that does not decrypt comes back empty, as with decryptText. */
export const unseal = async (values: string[]): Promise<string[]> => (await coreCall<string[]>({ op: "decryptText", values })).map(unpad);

/** Block sizes: a secret (PIN, generated value) fits one block; records grow a block at a time. */
export const BLOCK = { secret: 512, record: 1024, wordlist: 64 * 1024 } as const;

/**
 * After an unlock: values written before padding existed are padded once, so old ciphertexts stop telling
 * lengths. Each store is re-read before writing and only entries still unchanged are replaced, so a value
 * written meanwhile is never lost.
 */
export async function resealLegacy(): Promise<void> {
  const history = (await getLocal("genHistory")) ?? [];
  if (history.length) {
    const raw = await coreCall<string[]>({ op: "decryptText", values: history.map((e) => e.value) });
    const old = history.filter((e, i) => raw[i] && !isPadded(raw[i]!));
    if (old.length) {
      const fresh = await seal(old.map((e) => raw[history.indexOf(e)]!), BLOCK.secret);
      const swap = new Map(old.map((e, i) => [e.value, fresh[i]!]));
      const now = (await getLocal("genHistory")) ?? [];
      await setLocal("genHistory", now.map((e) => ({ ...e, value: swap.get(e.value) ?? e.value })));
    }
  }
  const alias = await getLocal("aliasSettings");
  if (alias) {
    const [raw] = await coreCall<string[]>({ op: "decryptText", values: [alias] });
    if (raw && !isPadded(raw)) {
      const [fresh] = await seal([raw], BLOCK.record);
      if ((await getLocal("aliasSettings")) === alias && fresh) await setLocal("aliasSettings", fresh);
    }
  }
  const pin = (await getLocal("account"))?.protectedPin;
  if (pin) {
    const [raw] = await coreCall<string[]>({ op: "decryptText", values: [pin] });
    if (raw && !isPadded(raw)) {
      const [fresh] = await seal([raw], BLOCK.secret);
      const account = await getLocal("account");
      if (account?.protectedPin === pin && fresh) await setLocal("account", { ...account, protectedPin: fresh });
    }
  }
}
