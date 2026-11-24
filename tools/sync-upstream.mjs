#!/usr/bin/env node
// Read-only upstream diff report. For every entry in upstream-map.yaml, compares the pin in
// upstream.lock with upstream main (via `gh api .../compare`) and prints Markdown grouped by local
// module, flagging likely breaking changes. Never edits code.
//   node tools/sync-upstream.mjs > upstream-report.md
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// shortcut: line-based parsers for our own two flat files, not general TOML/YAML; switch to real parsers if the formats grow.
function readLock() {
  const lock = {};
  let section;
  for (const line of readFileSync(join(root, "upstream.lock"), "utf8").split(/\r?\n/)) {
    const s = line.replace(/#.*$/, "").trim();
    const head = s.match(/^\[(.+)\]$/);
    if (head) lock[(section = head[1])] = {};
    else if (section && s.includes("=")) {
      const [k, v] = s.split(/=(.*)/s).map((x) => x.trim());
      lock[section][k] = v.replace(/^"|"$/g, "");
    }
  }
  return lock;
}

function readMap() {
  const entries = [];
  for (const line of readFileSync(join(root, "upstream-map.yaml"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^(-\s+|\s+)(\w+):\s*(.*)$/);
    if (!m) continue;
    if (m[1].startsWith("-")) entries.push({});
    entries.at(-1)[m[2]] = m[3];
  }
  return entries;
}

const lock = readLock();
const pins = {
  "sdk-internal": { slug: "bitwarden/sdk-internal", base: lock["sdk-internal"].rev, head: "main" },
  clients: { slug: "bitwarden/clients", base: lock.clients.commit, head: "main" },
  vaultwarden: { slug: "dani-garcia/vaultwarden", base: lock.vaultwarden.version, head: "main" },
};

// Patterns in added/removed lines that usually mean a protocol or format change.
const FLAGS = [
  [/\benum\b|=\s*\d+,\s*$/, "enum / numeric discriminant"],
  [/EncString|Cose|COSE|XChaCha|EncryptedString/, "key / EncString format"],
  [/\bKdf|Argon2|Pbkdf2|kdf_/i, "KDF"],
  [/#\[serde|pub struct|rename_all|alias\s*=/, "wire struct / serde shape"],
  [/required|missing field|Option</, "required vs optional field"],
  [/#\[(get|post|put|delete)\(/, "endpoint"],
  [/minimum_chrome_version|"permissions"|host_permissions/, "manifest"],
];

/** A diff header path: git quotes one with special or non-ASCII bytes, C-style ("a/caf\303\251.rs"). */
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const bytes = path.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, e) =>
    e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : ({ t: "\t", n: "\n" }[e] ?? e),
  );
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** A unified diff as the compare JSON's `files`: filename, status, additions, deletions, patch. */
function parseDiff(diff) {
  const files = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const m = chunk.match(/^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+)$/m);
    if (!m) continue;
    const [from, to] = [m[1], m[2]].map((p) => unquote(p).slice(2));
    const at = chunk.search(/^@@/m);
    const patch = at < 0 ? "" : chunk.slice(at);
    const lines = patch.split("\n");
    const status = /^new file mode/m.test(chunk)
      ? "added"
      : /^deleted file mode/m.test(chunk)
        ? "removed"
        : from !== to
          ? "renamed"
          : "modified";
    files.push({
      filename: to,
      status,
      additions: lines.filter((l) => l.startsWith("+")).length,
      deletions: lines.filter((l) => l.startsWith("-")).length,
      patch,
    });
  }
  return files;
}

const compares = new Map();
function compare(repo) {
  if (!compares.has(repo)) {
    const { slug, base, head } = pins[repo];
    const api = (...args) =>
      execFileSync("gh", ["api", ...args, `repos/${slug}/compare/${base}...${head}`], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
    // The JSON lists at most 300 files (on page 1 only); the diff media type carries every file.
    const { ahead_by, names } = JSON.parse(api("--jq", "{ahead_by, names: [.files[].filename]}"));
    const files = parseDiff(api("-H", "Accept: application/vnd.github.diff"));
    const parsed = new Set(files.map((f) => f.filename));
    const lost = names.filter((n) => !parsed.has(n));
    if (lost.length) throw new Error(`${repo}: the diff parser lost ${lost.join(", ")}`);
    compares.set(repo, { ahead_by, files });
  }
  return compares.get(repo);
}

const out = [`# Upstream sync report`, ``, `Generated ${new Date().toISOString()} from \`upstream.lock\`.`, ``];
for (const repo of Object.keys(pins)) {
  const c = compare(repo);
  out.push(`- **${repo}** \`${pins[repo].base.slice(0, 12)}\`…main: ${c.ahead_by} commits ahead`);
}
const byLocal = new Map();
for (const e of readMap()) byLocal.set(e.local, [...(byLocal.get(e.local) ?? []), e]);

for (const [local, entries] of byLocal) {
  const sections = [];
  for (const e of entries) {
    const files = (compare(e.repo).files ?? []).filter((f) => f.filename.startsWith(e.path));
    if (!files.length) continue;
    sections.push(`### ${e.repo}: \`${e.path}\``, `_${e.sync}_`, ``);
    for (const f of files) {
      const changed = (f.patch ?? "").split("\n").filter((l) => /^[+-](?![+-])/.test(l));
      const flags = [...new Set(FLAGS.filter(([re]) => changed.some((l) => re.test(l))).map(([, n]) => n))];
      sections.push(`- \`${f.filename}\` ${f.status} +${f.additions}/-${f.deletions}${flags.length ? ` ⚠️ ${flags.join(", ")}` : ""}`);
    }
    sections.push(``);
  }
  out.push(``, `## ${local}`, ``, ...(sections.length ? sections : ["No upstream changes.", ""]));
}
console.log(out.join("\n"));
