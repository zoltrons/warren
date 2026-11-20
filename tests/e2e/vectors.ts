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
// login, sync and list. Every password account; TDE and Key Connector have no master password.
export const vectorDir = join(root, process.env.WARREN_TEST_VECTORS ?? "target/test-vectors", "users");
// V2 accounts (signing keys, blob-encrypted items) register on Vaultwarden after 1.37.5: `testing` today, `latest` from
// the next release on, without a change here.
const vw = String(await call(BASE, "GET", "/api/version"));
const [maj = 0, min = 0, patch = 0] = vw.split(/[.-]/).map(Number);
const v2Server = maj * 1e6 + min * 1e3 + patch > 1_037_005 || (vw.startsWith("1.37.5-"));
if (!v2Server) console.log(`    Vaultwarden ${vw} cannot register V2 accounts: the v2 vectors run on testing`);
for (const name of ["v1-pbkdf2-password", "v1-argon2id-password", ...(v2Server ? ["v2-pbkdf2-blob", "v2-argon2id-blob"] : [])]) {
  await step(`test vector ${name}: registered as is, Warren logs in, lists and decrypts its vault`, async () => {
    const v = JSON.parse(readFileSync(join(vectorDir, `${name}.json`), "utf8")); // run tools/fetch-test-vectors.sh first
    const { email, password, kdf } = v.account;
    const authHash = v.masterPasswordAuthenticationHash as string;
    // The email (the KDF salt) is fixed, so a server kept from an earlier run still has the account.
    const old = await passwordToken(BASE, { email, authHash, deviceId: crypto.randomUUID() }).catch(() => undefined);
    if (old) await call(BASE, "DELETE", "/api/accounts", { token: old.access_token, json: { masterPasswordHash: authHash } });
    const a2 = kdf.argon2id;
    const { V1, V2 } = v.account.accountCryptographicState;
    const raw = v.rawCryptographicState;
    // A V2 account registers with its whole state, as the clients do (Vaultwarden's AccountKeysRequestModel).
    const keys = V2
      ? {
          accountKeys: {
            userKeyEncryptedAccountPrivateKey: V2.private_key,
            accountPublicKey: raw.publicKey,
            publicKeyEncryptionKeyPair: { wrappedPrivateKey: V2.private_key, publicKey: raw.publicKey, signedPublicKey: V2.signed_public_key },
            signatureKeyPair: { signatureAlgorithm: "ed25519", wrappedSigningKey: V2.signing_key, verifyingKey: raw.verifyingKey },
            securityState: { securityState: V2.security_state, securityVersion: v.account.securityVersion },
          },
        }
      : { userAsymmetricKeys: { publicKey: raw.publicKey, encryptedPrivateKey: V1.private_key } };
    const token = await call(BASE, "POST", "/identity/accounts/register/send-verification-email", { json: { email, name } });
    await call(BASE, "POST", "/identity/accounts/register/finish", {
      json: {
        email, emailVerificationToken: token, masterPasswordHash: authHash, key: v.unlockMethods[0].masterPasswordUnlock.master_password_unlock.masterKeyWrappedUserKey,
        kdf: a2 ? 1 : 0, kdfIterations: a2 ? a2.iterations : kdf.pBKDF2.iterations, kdfMemory: a2?.memory ?? null, kdfParallelism: a2?.parallelism ?? null,
        ...keys,
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
    const synced = async () => ((await call(BASE, "GET", "/api/sync?excludeDomains=true", { token: tok.access_token })) as { ciphers: { data?: unknown; name?: unknown }[] }).ciphers;
    for (const c of personal) {
      const d = c.decrypted;
      await rows().filter({ hasText: d.name }).first().click();
      await page.getByRole("heading", { name: d.name }).waitFor();
      await page.getByRole("button", { name: "Show password" }).first().click();
      await page.getByText(d.login.password, { exact: true }).waitFor();
      const text = await page.locator("#app").innerText();
      assert.ok(text.includes(d.login.username) && (!d.notes || text.includes(d.notes)), `${d.name}: username or notes missing`);
      // A blob item (a V2 account's) is edited like any other, and saved as a blob again, as the SDK writes it.
      if (c.blobEncrypted) {
        await page.getByRole("button", { name: "Edit" }).click();
        await page.getByLabel("Notes", { exact: true }).fill(`${d.name}: edited in Warren`);
        await page.getByRole("button", { name: "Save" }).click();
        await page.getByText(`${d.name}: edited in Warren`).waitFor();
      }
      await back();
    }
    if (V2) {
      const stored = await synced();
      assert.equal(stored.length, personal.length);
      for (const c of stored) assert.ok(c.name === null && String(c.data).includes('"format_version":1'), "a V2 item was not saved as a blob");
    }
  });
}
