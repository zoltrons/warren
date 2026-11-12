// "Have I Been Pwned" password check with k-anonymity: only the first 5 hex digits of the SHA-1 leave
// the device, and the response is padded so its size does not reveal the match either.
import { parseRange, sha1Hex } from "../shared/pwned-range.ts";

const API = "https://api.pwnedpasswords.com/range/";

/** How many times `suffix` appears in a range response (lines of `SUFFIX:COUNT`); padding rows count 0. */
export const countInRange = (body: string, suffix: string): number => parseRange(body).get(suffix) ?? 0;

/** One padded range answer for a 5-digit SHA-1 prefix. */
export async function fetchRange(prefix: string): Promise<string> {
  const res = await fetch(API + prefix, { headers: { "Add-Padding": "true" }, credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function pwnedCount(password: string): Promise<number> {
  const hex = await sha1Hex(password);
  return countInRange(await fetchRange(hex.slice(0, 5)), hex.slice(5));
}
