// The "Have I Been Pwned" range answer (lines of `SUFFIX:COUNT`) and the SHA-1 split it is queried with.

/** Suffix -> count. Padding rows (count 0) are dropped. */
export function parseRange(body: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of body.split(/\r?\n/)) {
    const [suffix, n] = line.split(":");
    const count = Number(n) || 0;
    if (suffix && count > 0) out.set(suffix.trim().toUpperCase(), count);
  }
  return out;
}

/** Upper-case hex SHA-1 of a password. */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
