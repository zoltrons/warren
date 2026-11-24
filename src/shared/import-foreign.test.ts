// KeePass XML and 1Password .1pux become Bitwarden export items; the XML and ZIP readers under them hold their limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { onePuxDataToExport, onePuxToExport } from "./import-1password.ts";
import { keepassTotp, keepassXmlToExport } from "./import-keepass.ts";
import { parseXml } from "./xml.ts";
import { readZipEntry } from "./zip.ts";

test("xml: entities, CDATA, self-closing tags; broken markup throws", () => {
  const n = parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b>p&lt;&#x41;&#66;</b><c/><d><![CDATA[<raw> & ]]></d></a>`);
  assert.equal(n.attrs.x, "1 & 2");
  assert.equal(n.children[0]!.text, "p<AB");
  assert.equal(n.children[1]!.name, "c");
  assert.equal(n.children[2]!.text, "<raw> & ");
  assert.throws(() => parseXml("<a><b></a>"));
  assert.throws(() => parseXml("<a>"));
  // An entity a DTD would define is never expanded.
  assert.equal(parseXml("<a>&xxe;</a>").text, "&xxe;");
});

const KEEPASS = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile><Meta><RecycleBinUUID>BIN</RecycleBinUUID></Meta><Root><Group><UUID>ROOT</UUID><Name>Database</Name>
  <Entry><String><Key>Title</Key><Value>Top</Value></String><String><Key>Password</Key><Value ProtectInMemory="True">  p w  </Value></String></Entry>
  <Group><UUID>G1</UUID><Name>Email</Name><Group><UUID>G2</UUID><Name>Work</Name>
    <Entry>
      <String><Key>Title</Key><Value>Mail</Value></String>
      <String><Key>UserName</Key><Value>me@x.test</Value></String>
      <String><Key>Password</Key><Value ProtectInMemory="True">s3cr&amp;t</Value></String>
      <String><Key>URL</Key><Value>https://mail.x.test</Value></String>
      <String><Key>Notes</Key><Value>line1
line2</Value></String>
      <String><Key>otp</Key><Value>otpauth://totp/x?secret=JBSWY3DP</Value></String>
      <String><Key>PIN</Key><Value ProtectInMemory="True">1234</Value></String>
      <String><Key>Recovery</Key><Value>abc</Value></String>
      <History><Entry><String><Key>Title</Key><Value>Old</Value></String></Entry></History>
    </Entry>
    <Entry><String><Key>Title</Key><Value>KP2</Value></String><String><Key>UserName</Key><Value>k</Value></String><String><Key>TimeOtp-Secret-Base32</Key><Value ProtectInMemory="True">JBSWY3DP</Value></String></Entry>
    <Entry><String><Key>Title</Key><Value>Just a note</Value></String><String><Key>Notes</Key><Value>n</Value></String></Entry>
  </Group></Group>
  <Group><UUID>BIN</UUID><Name>Recycle Bin</Name><Entry><String><Key>Title</Key><Value>Gone</Value></String></Entry></Group>
</Group></Root></KeePassFile>`;

test("KeePass XML: groups are folders, protected strings hidden fields, the recycle bin and history left out", () => {
  const r = keepassXmlToExport(KEEPASS);
  assert.deepEqual(r.folders, [{ id: "0", name: "Email/Work" }]);
  assert.deepEqual(
    r.items.map((i) => i.name),
    ["Top", "Mail", "KP2", "Just a note"],
  );
  const [top, mail, kp2, note] = r.items as Record<string, any>[];
  assert.equal(kp2!.login.totp, "JBSWY3DP", "KeePass 2's own TOTP secret");
  assert.deepEqual(kp2!.fields, []);
  assert.equal(top!.folderId, null);
  assert.equal(top!.login.password, "  p w  ", "a password is never trimmed");
  assert.equal(mail!.folderId, "0");
  assert.deepEqual(mail!.login, { username: "me@x.test", password: "s3cr&t", totp: "otpauth://totp/x?secret=JBSWY3DP", uris: [{ uri: "https://mail.x.test", match: null }] });
  assert.equal(mail!.notes, "line1\nline2");
  assert.deepEqual(mail!.fields, [
    { name: "PIN", value: "1234", type: 1 },
    { name: "Recovery", value: "abc", type: 0 },
  ]);
  assert.equal(note!.type, 2);
  assert.throws(() => keepassXmlToExport("<other/>"), /KeePass/);
});

test("KeePass TOTP: KeePass 2's encodings and settings, the KeeOtp and KeeTrayTOTP plugins' settings and Steam", () => {
  const of = (m: Record<string, string>) => keepassTotp((k) => m[k] ?? "");
  // "Hello!" (48 65 6c 6c 6f 21) is JBSWY3DPEE in Base32.
  assert.deepEqual(of({ "TimeOtp-Secret-Base32": "jbsw y3dp" }), { totp: "JBSWY3DP", used: ["TimeOtp-Secret-Base32"] });
  assert.equal(of({ "TimeOtp-Secret-Hex": "48656c6c6f21" }).totp, "JBSWY3DPEE");
  assert.equal(of({ "TimeOtp-Secret-Base64": "SGVsbG8h" }).totp, "JBSWY3DPEE");
  assert.equal(of({ "TimeOtp-Secret": "Hello!" }).totp, "JBSWY3DPEE");
  assert.deepEqual(of({ "TimeOtp-Secret-Base32": "JBSWY3DP", "TimeOtp-Length": "8", "TimeOtp-Period": "60", "TimeOtp-Algorithm": "HMAC-SHA-256" }), {
    totp: "otpauth://totp/?secret=JBSWY3DP&digits=8&period=60&algorithm=SHA256",
    used: ["TimeOtp-Secret-Base32", "TimeOtp-Length", "TimeOtp-Period", "TimeOtp-Algorithm"],
  });
  assert.deepEqual(of({ "TimeOtp-Secret-Hex": "zz" }), { totp: null, used: [] }, "a secret that does not decode stays a field");
  // KeeOtp: a query string under "otp"; an HOTP one is not a TOTP and stays a field.
  assert.deepEqual(of({ otp: "key=jbsw y3dp" }), { totp: "JBSWY3DP", used: ["otp"] });
  assert.equal(of({ otp: "key=JBSWY3DP&size=8&step=60&otpHashMode=Sha256" }).totp, "otpauth://totp/?secret=JBSWY3DP&digits=8&period=60&algorithm=SHA256");
  assert.deepEqual(of({ otp: "key=JBSWY3DP&type=Hotp&counter=3" }), { totp: null, used: [] });
  assert.equal(of({ otp: " otpauth://totp/x?secret=JBSWY3DP " }).totp, "otpauth://totp/x?secret=JBSWY3DP");
  assert.deepEqual(of({ otp: "jbsw y3dp" }), { totp: "JBSWY3DP", used: ["otp"] }, "a bare secret under otp");
  assert.equal(of({ "TOTP Seed": "JBSWY3DP", "TOTP Settings": "30;6" }).totp, "JBSWY3DP");
  assert.equal(of({ "TOTP Seed": "JBSWY3DP", "TOTP Settings": "60;8" }).totp, "otpauth://totp/?secret=JBSWY3DP&digits=8&period=60&algorithm=SHA1");
  assert.deepEqual(of({ "TOTP Seed": "JBSWY3DP", "TOTP Settings": "30;S" }), { totp: "steam://JBSWY3DP", used: ["TOTP Seed", "TOTP Settings"] });
  // Through the entry: the settings are not left behind as custom fields.
  const xml = `<KeePassFile><Root><Group><Name>D</Name><Entry><String><Key>Title</Key><Value>T</Value></String><String><Key>TimeOtp-Secret-Base32</Key><Value>JBSWY3DP</Value></String><String><Key>TimeOtp-Length</Key><Value>8</Value></String></Entry></Group></Root></KeePassFile>`;
  const e = keepassXmlToExport(xml).items[0] as Record<string, any>;
  assert.equal(e.login.totp, "otpauth://totp/?secret=JBSWY3DP&digits=8&period=30&algorithm=SHA1");
  assert.deepEqual(e.fields, []);
});

test("KeePass references: another entry's field by UUID is filled in, chains too; others stay as written", () => {
  // UUIDs: AAECAwQFBgcICQoLDA0ODw== is 000102...0f, EBESExQVFhcYGRobHB0eHw== is 101112...1f.
  const xml = `<KeePassFile><Root><Group><Name>D</Name>
    <Entry><UUID>AAECAwQFBgcICQoLDA0ODw==</UUID><String><Key>Title</Key><Value>Main</Value></String><String><Key>UserName</Key><Value>ada</Value></String><String><Key>Password</Key><Value ProtectInMemory="True">s3cret</Value></String></Entry>
    <Entry><UUID>EBESExQVFhcYGRobHB0eHw==</UUID><String><Key>Title</Key><Value>Alias</Value></String><String><Key>UserName</Key><Value>{REF:U@I:000102030405060708090A0B0C0D0E0F}</Value></String><String><Key>Password</Key><Value>{REF:P@I:000102030405060708090a0b0c0d0e0f}!</Value></String></Entry>
    <Entry><String><Key>Title</Key><Value>Chain</Value></String><String><Key>Password</Key><Value>{REF:P@I:101112131415161718191a1b1c1d1e1f}</Value></String><String><Key>Other</Key><Value>{REF:P@T:Main} {REF:P@I:ffffffffffffffffffffffffffffffff}</Value></String><String><Key>AltPass</Key><Value>{REF:P@I:000102030405060708090a0b0c0d0e0f}</Value></String><String><Key>Who</Key><Value>{REF:U@I:000102030405060708090a0b0c0d0e0f}</Value></String></Entry>
  </Group></Root></KeePassFile>`;
  const [, alias, chain] = keepassXmlToExport(xml).items as Record<string, any>[];
  assert.deepEqual([alias!.login.username, alias!.login.password], ["ada", "s3cret!"]);
  assert.equal(chain!.login.password, "s3cret!");
  assert.deepEqual(chain!.fields, [
    { name: "Other", value: "{REF:P@T:Main} {REF:P@I:ffffffffffffffffffffffffffffffff}", type: 0 },
    { name: "AltPass", value: "s3cret", type: 1 }, // another entry's password stays hidden in an unprotected field
    { name: "Who", value: "ada", type: 0 },
  ]);
});

test("attached files are not imported, and the items that had them are named", () => {
  const xml = `<KeePassFile><Root><Group><Name>D</Name>
    <Entry><String><Key>Title</Key><Value>Scan</Value></String><Binary><Key>id.pdf</Key><Value Ref="0"/></Binary></Entry>
    <Entry><String><Key>Title</Key><Value>Plain</Value></String></Entry>
  </Group></Root></KeePassFile>`;
  assert.deepEqual(keepassXmlToExport(xml).attachmentsLeft, ["Scan"]);
  const doc = (details: unknown) => ({ categoryUuid: "006", overview: { title: "Doc" }, details });
  const r = onePuxDataToExport({ accounts: [{ vaults: [{ items: [doc({ documentAttributes: { fileName: "a.pdf", documentId: "x" } }), { ...doc({ sections: [{ fields: [{ title: "f", value: { file: { fileName: "b.png" } } }] }] }), overview: { title: "Field" } }, doc({})] }] }] });
  assert.deepEqual(r.attachmentsLeft, ["Doc", "Field"]);
});

const ONEPUX = {
  accounts: [
    {
      vaults: [
        {
          attrs: { name: "Private" },
          items: [
            {
              categoryUuid: "001",
              favIndex: 1,
              state: "active",
              overview: { title: "GitHub", urls: [{ url: "https://github.com" }, { url: "https://gist.github.com" }] },
              details: {
                loginFields: [
                  { value: "octo", designation: "username", fieldType: "T", name: "login" },
                  { value: "pw1", designation: "password", fieldType: "P", name: "password" },
                  { value: "", fieldType: "B", name: "submit" },
                ],
                notesPlain: "hi",
                sections: [{ fields: [{ title: "one-time password", id: "TOTP_1", value: { totp: "otpauth://totp/g?secret=AAAA" } }, { title: "recovery", id: "r", value: { concealed: "rc" } }] }],
                passwordHistory: [{ value: "old", time: 1700000000 }],
              },
            },
            { categoryUuid: "001", state: "active", trashed: true, overview: { title: "Trashed" }, details: {} },
          ],
        },
        {
          attrs: { name: "Shared" },
          items: [
            {
              categoryUuid: "002",
              overview: { title: "Visa" },
              details: { sections: [{ fields: [{ id: "cardholder", value: { string: "Ada" } }, { id: "ccnum", value: { creditCardNumber: "4111111111111111" } }, { id: "cvv", value: { concealed: "123" } }, { id: "expiry", value: { monthYear: 202907 } }, { id: "type", value: { creditCardType: "visa" } }] }] },
            },
            {
              categoryUuid: "004",
              overview: { title: "Me" },
              details: { sections: [{ fields: [{ id: "firstname", value: { string: "Ada" } }, { id: "lastname", value: { string: "L" } }, { id: "address", value: { address: { street: "1 Main", city: "Town", zip: "123", country: "tr" } } }, { id: "email", value: { email: { email_address: "a@x.test" } } }] }] },
            },
            { categoryUuid: "110", overview: { title: "Server" }, details: { sections: [{ fields: [{ title: "admin password", id: "p", value: { concealed: "root" } }, { title: "url", id: "u", value: { string: "ssh://h" } }] }] } },
          ],
        },
      ],
    },
  ],
};

test("1pux: logins, cards and identities map to their types; other categories are notes; vaults are folders", async () => {
  const r = onePuxDataToExport(ONEPUX);
  assert.deepEqual(r.folders, [
    { id: "0", name: "Private" },
    { id: "1", name: "Shared" },
  ]);
  assert.deepEqual(
    r.items.map((i) => i.name),
    ["GitHub", "Visa", "Me", "Server"],
  );
  const [login, card, identity, server] = r.items as Record<string, any>[];
  assert.equal(login!.favorite, true);
  assert.deepEqual(login!.login, { username: "octo", password: "pw1", totp: "otpauth://totp/g?secret=AAAA", uris: [{ uri: "https://github.com", match: null }, { uri: "https://gist.github.com", match: null }] });
  assert.deepEqual(login!.fields, [{ name: "recovery", value: "rc", type: 1 }]);
  assert.equal(login!.passwordHistory[0].password, "old");
  assert.deepEqual(card!.card, { cardholderName: "Ada", brand: "visa", number: "4111111111111111", code: "123", expMonth: "7", expYear: "2029" });
  assert.equal(card!.folderId, "1");
  assert.equal(identity!.identity.address1, "1 Main");
  assert.equal(identity!.identity.country, "TR");
  assert.equal(identity!.identity.email, "a@x.test");
  assert.equal(server!.type, 2);
  assert.deepEqual(server!.fields, [
    { name: "admin password", value: "root", type: 1 },
    { name: "url", value: "ssh://h", type: 0 },
  ]);
  // Through the ZIP reader, deflated.
  const zip = await zipOf("export.data", new TextEncoder().encode(JSON.stringify(ONEPUX)));
  assert.equal((await onePuxToExport(zip)).items.length, 4);
  await assert.rejects(onePuxToExport(await zipOf("other.txt", new Uint8Array([1]))), /1Password/);
  await assert.rejects(readZipEntry(zip, () => true, 10), /too large/);
});

test("1pux: an SSH key item keeps its private key, public key and fingerprint", () => {
  const key = { sshKey: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n", metadata: { publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:fp", keyType: "ed25519" } } };
  const items = (fields: unknown[], categoryUuid = "114") => onePuxDataToExport({ accounts: [{ vaults: [{ items: [{ categoryUuid, overview: { title: "K" }, details: { sections: [{ fields }] } }] }] }] }).items[0] as Record<string, any>;
  const k = items([{ id: "private_key", title: "private key", value: key }, { id: "c", title: "comment", value: { string: "laptop" } }]);
  assert.equal(k.type, 5);
  assert.deepEqual(k.sshKey, { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n", publicKey: "ssh-ed25519 AAAA", keyFingerprint: "SHA256:fp" });
  assert.deepEqual(k.fields, [{ name: "comment", value: "laptop", type: 0 }]);
  // Elsewhere, the private key is a hidden field rather than nothing.
  assert.deepEqual(items([{ id: "k", title: "deploy key", value: key }], "003").fields, [{ name: "deploy key", value: "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n", type: 1 }]);
});

/** A one-file ZIP with a deflated entry. */
async function zipOf(name: string, data: Uint8Array): Promise<Uint8Array> {
  const packed = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const n = new TextEncoder().encode(name);
  const le = (v: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (v >>> (8 * i)) & 0xff);
  const local = [...le(0x04034b50, 4), ...le(20, 2), 0, 0, ...le(8, 2), 0, 0, 0, 0, ...le(0, 4), ...le(packed.length, 4), ...le(data.length, 4), ...le(n.length, 2), 0, 0, ...n];
  const central = [...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), 0, 0, ...le(8, 2), 0, 0, 0, 0, ...le(0, 4), ...le(packed.length, 4), ...le(data.length, 4), ...le(n.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(0, 4), ...n];
  const cdAt = local.length + packed.length;
  const end = [...le(0x06054b50, 4), 0, 0, 0, 0, ...le(1, 2), ...le(1, 2), ...le(central.length, 4), ...le(cdAt, 4), 0, 0];
  return new Uint8Array([...local, ...packed, ...central, ...end]);
}
