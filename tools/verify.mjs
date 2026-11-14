#!/usr/bin/env node
// The one entry point for every check, the same locally and in CI (ci.yml calls the same stages).
//   node tools/verify.mjs [stage|task ...] [--only <e2e group,...>] [--coverage]
//
//   quick  (default)  typecheck, unit tests, contrast                         ~30 s, after every change
//   rust              cargo fmt --check, clippy, crypto test vectors, autofill engine tests
//   ext               wasm build, extension build, size budget, fill/biometric/passkey smoke tests (no server)
//   lint              actionlint, zizmor, gitleaks in the images ci.yml pins (docker or Apple container)
//   e2e               extension e2e vs. Vaultwarden on :8080 (--only auth,send,... for some groups)
//   push              wasm + quick + rust + ext + lint: what CI gates, run it before every push
//   all               push + e2e
// A task name (typecheck, unit, contrast, fmt, clippy, vectors, autofill, wasm, build, size, fill, biometric,
// passkeys, lint, e2e) runs just that task. Each task prints its time; the run ends with a summary and fails
// at the first failing task.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const take = (name, withValue) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, withValue ? 2 : 1);
  if (withValue && (!value || value.startsWith("-"))) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return withValue ? value : name;
};
const only = take("--only", true);
const coverage = take("--coverage", false) !== undefined;

// One toolchain and one browser for every child process.
if (spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0) {
  // A Homebrew cargo earlier on PATH has no wasm target; rustup's honours rust-toolchain.toml.
  const cargo = spawnSync("rustup", ["which", "cargo"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (cargo) process.env.PATH = `${dirname(cargo)}:${process.env.CARGO_HOME ?? join(homedir(), ".cargo")}/bin:${process.env.PATH}`;
}
const helium = join(homedir(), "Applications/Helium.app/Contents/MacOS/Helium");
if (!process.env.CHROME_PATH && existsSync(helium)) process.env.CHROME_PATH = helium;
process.env.PATH = `${join(root, "node_modules/.bin")}:${process.env.PATH}`;

const sh = (cmd, env = {}) => () => {
  const r = spawnSync(cmd, { cwd: root, shell: "/bin/bash", stdio: "inherit", env: { ...process.env, ...env } });
  return r.status === 0;
};
const have = (bin) => spawnSync("bash", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
// Downloads are done once per checkout; delete the file or folder to fetch again.
const psl = () => (existsSync(join(root, "dist/psl.json")) ? "" : "node tools/fetch-psl.mjs && ");
const wasmRegister = () => (existsSync(join(root, "dist/wasm-register/core_wasm_bg.wasm")) ? "" : "bash tools/build-wasm.sh --features register --out dist/wasm-register && ");
const AUTOFILL = "-p autofill-designation -p autofill-cpd -p autofill-clue -p autofill-autocomplete-off -p autofill-resolver -p autofill-autosubmit -p autofill-fill";

const tasks = {
  typecheck: () => sh(`${psl()}tsc -p tsconfig.json --noEmit`)(),
  unit: coverage
    ? sh(`mkdir -p coverage && node --test --experimental-strip-types --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info "src/**/*.test.ts"`)
    : sh(`node --test --experimental-strip-types "src/**/*.test.ts"`),
  contrast: sh("node tools/check-contrast.mjs"),
  fmt: sh("cargo fmt --check"),
  clippy: sh("cargo clippy --all-targets -- -D warnings"),
  // fetch-test-vectors.sh downloads only when target/test-vectors is not at upstream.lock's rev.
  vectors: sh("bash tools/fetch-test-vectors.sh && cargo test -p warren-core-wasm", { WARREN_TEST_VECTORS: "target/test-vectors" }),
  autofill: sh(`cargo test ${AUTOFILL}`),
  wasm: sh("bash tools/build-wasm.sh --simd && bash tools/build-wasm.sh --features register --out dist/wasm-register"),
  build: () => sh(`${psl()}node tools/build.mjs`)(),
  size: () => {
    const r = spawnSync("node", ["tools/size-report.mjs", "--check"], { cwd: root, encoding: "utf8" });
    process.stdout.write(r.stdout + r.stderr);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + r.stdout + "```\n");
    return r.status === 0;
  },
  fill: sh("node tools/smoke-fill.mjs"),
  biometric: () => sh(`${wasmRegister()}node tools/build.mjs --e2e && node tools/smoke-biometric.mjs`)(),
  passkeys: sh("node tools/smoke-passkeys.mjs"),
  // ci.yml's container checks (actionlint, zizmor, gitleaks), read from ci.yml so the pinned images stay in one place.
  lint: () => {
    const rt = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? "docker" : have("container") ? "container" : "";
    if (!rt) return console.log("no docker or Apple container: CI runs actionlint, zizmor and gitleaks"), true;
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const cmds = [...ci.matchAll(/^\s+- run: (docker run .+)$/gm)].map((m) => m[1].replace(/^docker/, rt));
    return cmds.length > 0 && cmds.every((c) => sh(c)());
  },
  e2e: () => {
    const up = spawnSync("curl", ["-sf", "-o", "/dev/null", `${process.env.VW_URL ?? "http://localhost:8080"}/alive`]).status === 0;
    if (!up) {
      console.error("Vaultwarden is not answering on :8080. Start it (docker or Apple container): bash dev/vaultwarden/up.sh");
      return false;
    }
    return sh(`bash tools/fetch-test-vectors.sh && ${wasmRegister()}${psl()}node tools/build.mjs --e2e >/dev/null && node --experimental-strip-types tests/e2e/run.ts${only ? ` --only ${only}` : ""}`)();
  },
};
const stages = {
  quick: ["typecheck", "unit", "contrast"],
  rust: ["fmt", "clippy", "vectors", "autofill"],
  ext: ["wasm", "build", "size", "fill", "biometric", "passkeys"],
  lint: ["lint"],
};
// wasm first: typecheck reads the wasm-bindgen declarations in dist/wasm.
stages.push = ["wasm", ...stages.quick, ...stages.rust, ...stages.ext, "lint"];
stages.all = [...stages.push, "e2e"];

const wanted = (args.length ? args : ["quick"]).flatMap((a) => stages[a] ?? (tasks[a] ? [a] : (console.error(`unknown stage or task: ${a}`), process.exit(2))));
const plan = [...new Set(wanted)];
const done = [];
let failed = "";
for (const name of plan) {
  console.log(`\n▶ ${name}`);
  const t = performance.now();
  const ok = tasks[name]();
  done.push(`${ok ? "ok  " : "FAIL"} ${name.padEnd(10)} ${((performance.now() - t) / 1000).toFixed(1).padStart(6)} s`);
  if (!ok) {
    failed = name;
    break;
  }
}
console.log(`\n${done.join("\n")}${failed ? `\n\nverify failed at ${failed}` : `\n\nverify ok (${plan.length} tasks)`}`);
process.exit(failed ? 1 : 0);
