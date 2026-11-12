// Domains that offer authenticator-app codes (totp-sites.json, tools/totp-sites.mjs). Read from the extension's own
// files, never from the network.
let sites: Set<string> | undefined;
let loading: Promise<void> | undefined;

export function loadTotpSites(): Promise<void> {
  return (loading ??= fetch(new URL("totp-sites.json", import.meta.url))
    .then((r) => r.json() as Promise<string[]>)
    .then((list) => void (sites = new Set(list)))
    .catch(() => void (loading = undefined)));
}

/** For tests: the list without a fetch. */
export const setTotpSites = (list: string[]) => void (sites = new Set(list));

/** Whether `host` or any parent domain of it (a.b.example.com, b.example.com, example.com) offers TOTP. False until loaded. */
export function offersTotp(host: string): boolean {
  if (!sites) return false;
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length - 1; i++) if (sites.has(labels.slice(i).join("."))) return true;
  return false;
}
