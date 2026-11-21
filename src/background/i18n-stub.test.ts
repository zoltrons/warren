// Not a test: chrome.i18n over the English messages for unit tests (named .test.ts so tsc and the bundle skip it).
import { readFileSync } from "node:fs";

const en = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8")) as Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

export const i18n = {
  getMessage(key: string, subs: string[] = []): string {
    const m = en[key];
    if (!m) return "";
    const fill = (s: string) => s.replace(/\$(\d)/g, (_, n: string) => subs[Number(n) - 1] ?? "");
    return m.message.replace(/\$([a-z0-9_]+)\$/gi, (_, name: string) => fill(m.placeholders?.[name.toLowerCase()]?.content ?? "")).replaceAll("$$", "$");
  },
};
