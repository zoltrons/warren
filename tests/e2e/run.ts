// End-to-end suite: the real extension in a Chromium-based browser against a local Vaultwarden (latest).
//   bash dev/vaultwarden/up.sh            (Vaultwarden latest + mock IdP; docker compose or Apple container)
//   bash tools/build-wasm.sh --features register --out dist/wasm-register   (test-only account setup)
//   node tools/fetch-psl.mjs && node tools/build.mjs --e2e                  (-> dist/ext-e2e)
//   CHROME_PATH=<chromium-based browser that honours --load-extension> node --experimental-strip-types tests/e2e/run.ts [--only vault,inline]
//
// Each group is a module of `await step("…")` blocks, run in the order below. A group imports the groups whose fixtures
// it uses (inline imports autofill imports vault), so --only runs those first; the others start on their own with
// ensureSignedIn(). Shared fixtures, the browser and the test site live in harness.ts.
import { rmSync } from "node:fs";

const GROUPS = ["auth", "webauthn", "send", "vault", "autofill", "inline", "passkeys", "sso"];
const at = process.argv.indexOf("--only");
const only = at > 0 ? (process.argv[at + 1] ?? "").split(",").filter(Boolean) : GROUPS;
const unknown = only.filter((g) => !GROUPS.includes(g));
if (!only.length || unknown.length) {
  console.error(`unknown e2e group: ${unknown.join(",") || "(none given)"}; groups: ${GROUPS.join(", ")}`);
  process.exit(2);
}

const { ctx, endGroup, passed, profile, site, skipped } = await import("./harness.ts");
try {
  for (const g of GROUPS) {
    if (!only.includes(g)) continue;
    await import(`./${g}.ts`);
    endGroup();
  }
  console.log(`\n${passed.length} steps passed, ${skipped.length} skipped (${(await ctx.browser()?.version()) ?? "persistent context"})`);
} finally {
  await ctx.close();
  site.close();
  rmSync(profile, { recursive: true, force: true });
}
