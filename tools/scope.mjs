// Which checks a change needs, from the paths it touches: ci.yml's `changes` job and `verify.mjs push` both ask here,
// so a push runs the same jobs locally and in CI. The nightly and dispatched runs skip it and run every job; a release
// requires one of those (release.yml `ci-passed`). A path no pattern names counts as code, so a new kind of file runs
// everything rather than nothing.
//   node tools/scope.mjs [<base sha>]   rust=, ext=, e2e= lines for $GITHUB_OUTPUT, from `git diff <base> HEAD`;
//                                       everything when no base is given or it cannot be fetched (new branch, force push)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Needs no build or test: the workflow lint and the secret scan, which run on every change, cover it.
const NONE =
  /^(docs\/|site\/|brand\/|dev\/preview\/|[^/]+\.md$|LICENSE$|NOTICE$|renovate\.json$|deny\.toml$|\.github\/(?!workflows\/ci\.yml$)|tools\/(release\.sh|verify-tag\.sh|sync-upstream\.mjs)$)/;
// The Rust job: fmt, clippy, crypto test vectors, autofill engine tests.
const RUST = /^(crates\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|upstream\.lock$|\.cargo\/|tools\/fetch-test-vectors\.sh$)/;
// Code the e2e suite never runs: unit tests and the tools that only measure, smoke-test or pack.
const NO_E2E = /(\.test\.(ts|mjs)$|^tools\/(smoke-[^/]+|check-contrast\.mjs|size-[^/]+|mutate\.mjs|icons\.mjs|pack-crx\.mjs)$)/;
// The check definitions themselves.
const ALL = /^(tools\/(verify|scope)\.mjs|\.github\/workflows\/ci\.yml)$/;

/** @param {string[]} files repository-relative paths @returns {{ rust: boolean, ext: boolean, e2e: boolean }} */
export function scope(files) {
  const code = files.filter((f) => !NONE.test(f));
  const all = code.some((f) => ALL.test(f));
  return { rust: all || code.some((f) => RUST.test(f)), ext: code.length > 0, e2e: all || code.some((f) => !NO_E2E.test(f)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? "";
  const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
  // Fetched only when missing (CI's one-commit checkout): a shallow fetch into a full clone would cut its history there.
  const have = (sha) => git("cat-file", "-e", `${sha}^{commit}`).status === 0;
  let files;
  if (/^[0-9a-f]{40}$/.test(base) && !/^0+$/.test(base) && (have(base) || git("fetch", "-q", "--depth=1", "origin", base).status === 0)) {
    const diff = git("diff", "--name-only", "--no-renames", base, "HEAD");
    if (diff.status === 0) files = diff.stdout.split("\n").filter(Boolean);
  }
  const s = files ? scope(files) : { rust: true, ext: true, e2e: true };
  console.error(files ? `${files.length} files changed since ${base.slice(0, 7)}:\n  ${files.join("\n  ")}` : "no base to compare with: every job");
  for (const [k, v] of Object.entries(s)) console.log(`${k}=${v}`);
}
