// e2e group "vectors": sdk-internal user test vectors through Vaultwarden and the extension.
// Runs alone with --only vectors (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { passwordToken } from "../../src/transport/auth.ts";
import { call } from "../../src/transport/http.ts";
import { BASE, root, step, page, loginAs, expectUnlocked, logout, rows, back, ensureSignedIn } from "./harness.ts";

await ensureSignedIn();
// Same data as crates/core-wasm/tests/vectors.rs, but here it goes through Vaultwarden and the extension's
// login, sync and list. Only V1 password accounts: V2 needs signing keys at registration, TDE/key connector no password.
export const vectorDir = join(root, process.env.WARREN_TEST_VECTORS ?? "target/test-vectors", "users");
for (const name of ["v1-pbkdf2-password", "v1-argon2id-password"]) {
  await step(`test vector ${name}: registered as is, Warren logs in, lists and decrypts its vault`, async () => {
    const v = JSON.parse(readFileSync(join(vectorDir, `${name}.json`), "utf8")); // run tools/fetch-test-vectors.sh first
    const { email, password, kdf } = v.account;
    const authHash = v.masterPasswordAuthenticationHash as string;
    // The email (the KDF salt) is fixed, so a server kept from an earlier run still has the account.
    const old = await passwordToken(BASE, { email, authHash, deviceId: crypto.randomUUID() }).catch(() => undefined);
    if (old) await call(BASE, "DELETE", "/api/accounts", { token: old.access_token, json: { masterPasswordHash: authHash } });
    const a2 = kdf.argon2id;
    const token = await call(BASE, "POST", "/identity/accounts/register/send-verification-email", { json: { email, name } });
    await call(BASE, "POST", "/identity/accounts/register/finish", {
      json: {
        email, emailVerificationToken: token, masterPasswordHash: authHash, key: v.unlockMethods[0].masterPasswordUnlock.master_password_unlock.masterKeyWrappedUserKey,
        kdf: a2 ? 1 : 0, kdfIterations: a2 ? a2.iterations : kdf.pBKDF2.iterations, kdfMemory: a2?.memory ?? null, kdfParallelism: a2?.parallelism ?? null,
        userAsymmetricKeys: { publicKey: v.rawCryptographicState.publicKey, encryptedPrivateKey: v.account.accountCryptographicState.V1.private_key },
      },
    });
    const tok = await passwordToken(BASE, { email, authHash, deviceId: crypto.randomUUID() });
    const userId = JSON.parse(Buffer.from(tok.access_token.split(".")[1]!, "base64url").toString()).sub as string;
    for (const f of v.vault.folders) await call(BASE, "POST", "/api/folders", { token: tok.access_token, json: { name: f.encrypted.name } });
    const personal = v.vault.ciphers.filter((c: any) => !c.encrypted.organizationId);
    for (const c of personal) {
      // The vectors carry attachment metadata but no file: the server takes attachments only through upload.
      const { id: _id, attachments: _a, folderId: _f, ...enc } = c.encrypted;
      await call(BASE, "POST", "/api/ciphers", { token: tok.access_token, json: { ...enc, encryptedFor: userId } });
    }

    await logout();
    await loginAs({ email, password, kdf: [0, 0, 0, 0] });
    await expectUnlocked();
    await rows().first().waitFor();
    const want = personal.map((c: any) => c.decrypted.name as string).sort();
    const got = (await rows().allTextContents()).map((t) => want.find((n: string) => t.includes(n)) ?? t).sort();
    assert.deepEqual(got, want);
    for (const f of v.vault.folders) await page.getByRole("button", { name: f.decrypted.name, exact: true }).waitFor();
    for (const c of personal) {
      const d = c.decrypted;
      await rows().filter({ hasText: d.name }).first().click();
      await page.getByRole("heading", { name: d.name }).waitFor();
      await page.getByRole("button", { name: "Show password" }).first().click();
      await page.getByText(d.login.password, { exact: true }).waitFor();
      const text = await page.locator("#app").innerText();
      assert.ok(text.includes(d.login.username) && (!d.notes || text.includes(d.notes)), `${d.name}: username or notes missing`);
      await back();
    }
  });
}
