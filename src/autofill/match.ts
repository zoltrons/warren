// URI matching with Bitwarden's UriMatchType semantics (clients: libs/common/src/models/domain/login-uri).
// A null `match` means "Default": the account's default URI match strategy (Domain unless changed).
import { URI_MATCH as MATCH } from "../shared/constants.ts";
import { isLoopback } from "../shared/url.ts";
export { MATCH };

/** Public Suffix List lookup (rules as in public_suffix_list.dat, punycode). */
export class Psl {
  private readonly rules: Set<string>;
  constructor(rules: Iterable<string>) {
    this.rules = new Set(rules);
  }

  /** True for "com", "co.uk", "github.io" (and "com.": read like baseDomain reads it): nobody owns them. */
  isPublicSuffix(domain: string): boolean {
    const d = domain.toLowerCase().replace(/\.$/, "");
    return this.baseDomain(`x.${d}`) === `x.${d}`;
  }

  /** Registrable domain ("eTLD+1"); IPs, single labels and public suffixes themselves map to the host. */
  baseDomain(host: string): string {
    const h = host.toLowerCase().replace(/\.$/, "");
    if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return h;
    const labels = h.split(".");
    let suffixLen = 1; // implicit "*" rule
    for (let i = 0; i < labels.length; i++) {
      const cand = labels.slice(i).join(".");
      if (this.rules.has(`!${cand}`)) {
        suffixLen = labels.length - i - 1;
        break;
      }
      if (this.rules.has(cand) || (i + 1 < labels.length && this.rules.has(`*.${labels.slice(i + 1).join(".")}`))) {
        suffixLen = labels.length - i;
        break;
      }
    }
    return labels.length > suffixLen ? labels.slice(labels.length - suffixLen - 1).join(".") : h;
  }
}

/**
 * Saved URIs may lack a scheme ("example.com"); Bitwarden treats those as http(s). Other schemes are not
 * websites: `androidapp://com.ebay.mobile` must not match the registrable domain ebay.mobile.
 */
function parseUri(uri: string): URL | undefined {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `http://${uri}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** JavaScript's RegExp backtracks: the worker passes a linear-time matcher (core-wasm `regexTest`). */
type RegexTest = (pattern: string, text: string) => boolean;
const jsRegexTest: RegexTest = (pattern, text) => {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
};

export function uriMatches(saved: string, match: number | null | undefined, page: URL, psl: Psl, defaultMatch: number = MATCH.Domain, regexTest: RegexTest = jsRegexTest): boolean {
  if (page.protocol !== "https:" && page.protocol !== "http:") return false;
  // A login saved for https must not be offered on a cleartext page (downgrade / SSL stripping).
  if (page.protocol === "http:" && /^https:\/\//i.test(saved) && !isLoopback(page.hostname)) return false;
  switch (match ?? defaultMatch) {
    case MATCH.Domain: {
      const s = parseUri(saved);
      if (!s?.hostname) return false;
      return s.hostname === page.hostname || psl.baseDomain(s.hostname) === psl.baseDomain(page.hostname);
    }
    case MATCH.Host:
      return parseUri(saved)?.host === page.host;
    case MATCH.StartsWith:
      // The prefix must end at a URL boundary: "https://example.com" is not "https://example.com.evil.net".
      return page.href.startsWith(saved) && (saved.endsWith("/") || "/?#".includes(page.href[saved.length] ?? "/"));
    case MATCH.Exact:
      return page.href === saved;
    case MATCH.RegularExpression:
      return regexTest(saved, page.href);
    default: // Never, unknown
      return false;
  }
}
