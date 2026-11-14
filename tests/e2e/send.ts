// e2e group "send": Send: text and file sends, edit, delete.
// Runs alone with --only send (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { createDecipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { call } from "../../src/transport/http.ts";
import { BASE, step, sw, readClipboard, page, open, fill, expectUnlocked, ensureSignedIn } from "./harness.ts";

await ensureSignedIn();
export const openSendTab = async () => {
  await page.getByRole("navigation").getByRole("button", { name: "Send" }).click();
  await page.getByRole("heading", { name: "Send", exact: true }).waitFor();
};
// A recipient opens the link. The web vault refuses plain-http servers, so this is the recipient
// flow over the API, decrypted with node:crypto (written from the spec, independent of core-wasm).
export const receive = async (link: string, password?: string) => {
  const m = /^(.+)\/#\/send\/([\w-]+)\/([\w-]+)$/.exec(link);
  assert.ok(m && m[1] === BASE, link);
  const [accessId, urlKey] = [m[2]!, m[3]!];
  const secret = Buffer.from(urlKey, "base64url");
  const prk = createHmac("sha256", "bitwarden-send").update(secret).digest();
  const t1 = createHmac("sha256", prk).update(Buffer.from("send\x01")).digest(); // HKDF-Expand, info "send"
  const t2 = createHmac("sha256", prk).update(Buffer.concat([t1, Buffer.from("send\x02")])).digest();
  const open = (iv: Buffer, mac: Buffer, ct: Buffer) => {
    assert.ok(createHmac("sha256", t2).update(Buffer.concat([iv, ct])).digest().equals(mac), "send MAC mismatch");
    const d = createDecipheriv("aes-256-cbc", t1, iv);
    return Buffer.concat([d.update(ct), d.final()]);
  };
  const str = (enc: string) => {
    const [iv, ct, mac] = enc.slice(2).split("|").map((b) => Buffer.from(b, "base64"));
    assert.equal(enc.slice(0, 2), "2.");
    return open(iv!, mac!, ct!).toString("utf8");
  };
  const form: Record<string, string> = { grant_type: "send_access", client_id: "web", send_id: accessId };
  if (password) form.password_hash_b64 = pbkdf2Sync(password, secret, 100_000, 32, "sha256").toString("base64");
  const { access_token: token } = (await call(BASE, "POST", "/identity/connect/token", { form })) as { access_token: string };
  const s = (await call(BASE, "POST", "/api/sends/access", { token })) as any;
  let file: Buffer | undefined;
  if (s.file) {
    const { url } = (await call(BASE, "POST", `/api/sends/access/file/${s.file.id}`, { token })) as { url: string };
    const b = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.equal(b[0], 2);
    file = open(b.subarray(1, 17), b.subarray(17, 49), b.subarray(49));
  }
  return { name: str(s.name), text: s.text?.text ? str(s.text.text) : undefined, fileName: s.file ? str(s.file.fileName) : undefined, file };
};

await step("Send: text send link decrypts for a recipient", async () => {
  await openSendTab();
  await page.getByRole("button", { name: "New Send" }).click();
  await fill("Name", "Wifi for guests");
  await page.getByLabel("Text", { exact: true }).fill("guest-wifi-pass-42");
  await page.getByRole("button", { name: "Create and copy link" }).click();
  await page.getByRole("listitem").filter({ hasText: "Wifi for guests" }).waitFor();
  const r = await receive(await readClipboard());
  assert.deepEqual([r.name, r.text], ["Wifi for guests", "guest-wifi-pass-42"]);
});

export let reportLink = "";
await step("Send: password-protected file send; server checks our password hash", async () => {
  await page.getByRole("button", { name: "New Send" }).click();
  await fill("Name", "Report");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByLabel("File", { exact: true }).setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("quarterly numbers\n") });
  await fill("Password (optional)", "s3nd-pw");
  await page.getByRole("button", { name: "Create and copy link" }).click();
  await page.getByRole("listitem").filter({ hasText: "Report" }).waitFor();
  const link = (reportLink = await readClipboard());
  await assert.rejects(receive(link, "wrong-pw"));
  const r = await receive(link, "s3nd-pw");
  assert.deepEqual([r.name, r.fileName, r.file?.toString("utf8")], ["Report", "report.txt", "quarterly numbers\n"]);
});

await step("Send: edit renames, keeps link and password; disabling stops access", async () => {
  // The row itself opens the Send for editing (there is no separate Edit button).
  await page.getByRole("listitem").filter({ hasText: "Report" }).locator(".row-main").click();
  await page.getByRole("heading", { name: "Edit Send" }).waitFor();
  await fill("Name", "Report Q3");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: "Report Q3" }).waitFor();
  assert.equal((await receive(reportLink, "s3nd-pw")).name, "Report Q3");
  await page.getByRole("listitem").filter({ hasText: "Report Q3" }).locator(".row-main").click();
  await page.getByLabel("Disable this Send").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: "Disabled" }).waitFor();
  await assert.rejects(receive(reportLink, "s3nd-pw"));
});

await step("Send: delete removes it on the server", async () => {
  await page.getByRole("button", { name: "Delete Wifi for guests" }).click();
  await page.getByRole("button", { name: "Click again to delete" }).click();
  await page.getByRole("status").filter({ hasText: "Send deleted" }).waitFor();
  // Full sync from the server, then a fresh popup that reads the list from the worker again.
  await sw.evaluate(() => chrome.storage.local.remove("vault"));
  await open();
  await expectUnlocked();
  await openSendTab();
  await page.getByRole("listitem").filter({ hasText: "Report" }).waitFor();
  assert.equal(await page.getByRole("listitem").filter({ hasText: "Wifi for guests" }).count(), 0);
  assert.equal(await page.getByRole("listitem").filter({ hasText: "Report" }).count(), 1);
});
