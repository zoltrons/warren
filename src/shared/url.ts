/** The URL of a web page (http or https), or undefined for anything else (chrome://, file:, none). */
export function httpUrl(page: { url?: string } | undefined): URL | undefined {
  const u = URL.parse(page?.url ?? "");
  return u?.protocol === "https:" || u?.protocol === "http:" ? u : undefined;
}

export const b64u = (b: Uint8Array): string => b.toBase64({ alphabet: "base64url", omitPadding: true });

/**
 * Loopback hosts. Plain http is tolerated for a server on this machine only (development); every
 * other host must use https, or the master password hash, the tokens and the vault travel in clear.
 */
export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Normalizes a user-entered server URL to origin + path, without trailing slash. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname)))
    throw new Error("Server URL must start with https:// (plain http is only allowed for localhost)");
  if (u.username || u.password || u.search || u.hash)
    throw new Error("Server URL must not contain credentials, a query or a fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}
