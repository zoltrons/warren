//! Warren crypto core: a small wasm-bindgen surface over `bitwarden-crypto`.
//!
//! All structured data crosses the boundary as JSON strings, one call per batch, so the JS glue
//! stays tiny and the whole vault is decrypted in a single call.

pub mod api;
mod cipher;
mod generator;
mod send;
mod totp;

use wasm_bindgen::prelude::*;

fn js(e: String) -> JsError {
    JsError::new(&e)
}

/// `kdfType`: 0 = PBKDF2-SHA256, 1 = Argon2id (`memory` in MiB). Returns an opaque handle.
#[wasm_bindgen(js_name = deriveMasterKey)]
pub fn derive_master_key(
    password: &str,
    email: &str,
    kdf_type: u8,
    iterations: u32,
    memory: u32,
    parallelism: u32,
) -> Result<u32, JsError> {
    let kdf = api::kdf_from_params(kdf_type, iterations, memory, parallelism).map_err(js)?;
    api::derive_master_key(password, email, &kdf).map_err(js)
}

/// Base64 master password hash. `local = false` gives the value sent to the server.
#[wasm_bindgen(js_name = makeAuthHash)]
pub fn make_auth_hash(handle: u32, password: &str, local: bool) -> Result<String, JsError> {
    api::make_auth_hash(handle, password, local).map_err(js)
}

#[wasm_bindgen(js_name = freeMasterKey)]
pub fn free_master_key(handle: u32) {
    api::free_master_key(handle)
}

#[wasm_bindgen(js_name = unlockUserKey)]
pub fn unlock_user_key(
    handle: u32,
    protected_user_key: &str,
    encrypted_private_key: Option<String>,
) -> Result<(), JsError> {
    api::unlock_user_key(handle, protected_user_key, encrypted_private_key.as_deref()).map_err(js)
}

/// The unlocked user key wrapped with a key derived from `pin` (the given KDF, email salt).
#[wasm_bindgen(js_name = pinProtectUserKey)]
pub fn pin_protect_user_key(
    pin: &str,
    email: &str,
    kdf_type: u8,
    iterations: u32,
    memory: u32,
    parallelism: u32,
) -> Result<String, JsError> {
    let kdf = api::kdf_from_params(kdf_type, iterations, memory, parallelism).map_err(js)?;
    api::pin_protect_user_key(pin, email, &kdf).map_err(js)
}

#[wasm_bindgen(js_name = unlockWithPin)]
#[allow(clippy::too_many_arguments)]
pub fn unlock_with_pin(
    pin: &str,
    email: &str,
    kdf_type: u8,
    iterations: u32,
    memory: u32,
    parallelism: u32,
    pin_protected_user_key: &str,
    encrypted_private_key: Option<String>,
) -> Result<(), JsError> {
    let kdf = api::kdf_from_params(kdf_type, iterations, memory, parallelism).map_err(js)?;
    api::unlock_with_pin(
        pin,
        email,
        &kdf,
        pin_protected_user_key,
        encrypted_private_key.as_deref(),
    )
    .map_err(js)
}

/// The unlocked user key wrapped with a key derived from a WebAuthn PRF output (base64, >= 32 bytes).
#[wasm_bindgen(js_name = prfProtectUserKey)]
pub fn prf_protect_user_key(prf_b64: &str) -> Result<String, JsError> {
    api::prf_protect_user_key(prf_b64).map_err(js)
}

/// Opens the session from a PRF-wrapped user key.
#[wasm_bindgen(js_name = unlockWithPrf)]
pub fn unlock_with_prf(
    prf_b64: &str,
    protected_user_key: &str,
    encrypted_private_key: Option<String>,
) -> Result<(), JsError> {
    api::unlock_with_prf(
        prf_b64,
        protected_user_key,
        encrypted_private_key.as_deref(),
    )
    .map_err(js)
}

/// Log in with device: a new RSA-2048 key pair, kept for the request. Returns `{"publicKey", "fingerprint"}`.
#[wasm_bindgen(js_name = authRequestCreate)]
pub fn auth_request_create(email: &str) -> Result<String, JsError> {
    api::auth_request_create(email).map_err(js)
}

/// Log in with device: opens the session from the user key an approving device wrapped for our public key.
#[wasm_bindgen(js_name = authRequestUnlock)]
pub fn auth_request_unlock(
    key: &str,
    encrypted_private_key: Option<String>,
) -> Result<(), JsError> {
    api::auth_request_unlock(key, encrypted_private_key.as_deref()).map_err(js)
}

/// Approves another device's auth request: the user key wrapped with its public key (base64 SPKI).
#[wasm_bindgen(js_name = authRequestApprove)]
pub fn auth_request_approve(public_key: &str) -> Result<String, JsError> {
    api::auth_request_approve(public_key).map_err(js)
}

#[wasm_bindgen(js_name = authRequestFingerprint)]
pub fn auth_request_fingerprint(email: &str, public_key: &str) -> Result<String, JsError> {
    api::auth_request_fingerprint(email, public_key).map_err(js)
}

#[wasm_bindgen(js_name = setOrgKeys)]
pub fn set_org_keys(org_keys_json: &str) -> Result<usize, JsError> {
    api::set_org_keys(org_keys_json).map_err(js)
}

#[wasm_bindgen]
pub fn lock() {
    api::lock()
}

/// Input: JSON array of ciphers as returned by `/api/sync`. Output: `{"ciphers": [...], "failed": [...]}`.
#[wasm_bindgen(js_name = decryptCipherList)]
pub fn decrypt_cipher_list(ciphers_json: &str) -> Result<String, JsError> {
    api::decrypt_cipher_list(ciphers_json).map_err(js)
}

#[wasm_bindgen(js_name = decryptCipher)]
pub fn decrypt_cipher(cipher_json: &str) -> Result<String, JsError> {
    api::decrypt_cipher(cipher_json).map_err(js)
}

#[wasm_bindgen(js_name = encryptCipher)]
pub fn encrypt_cipher(cipher_json: &str) -> Result<String, JsError> {
    api::encrypt_cipher(cipher_json).map_err(js)
}

#[wasm_bindgen(js_name = decryptFolders)]
pub fn decrypt_folders(folders_json: &str) -> Result<String, JsError> {
    api::decrypt_folders(folders_json).map_err(js)
}

/// Input: JSON array of sends from `/api/sync`. Output: `{"sends": [...], "failed": [...]}`, each with `urlKey`.
#[wasm_bindgen(js_name = decryptSendList)]
pub fn decrypt_send_list(sends_json: &str) -> Result<String, JsError> {
    api::decrypt_send_list(sends_json).map_err(js)
}

#[wasm_bindgen(js_name = encryptSend)]
pub fn encrypt_send(send_json: &str) -> Result<String, JsError> {
    api::encrypt_send(send_json).map_err(js)
}

/// `cipherJson`: the cipher holding attachment `id`. Returns the decrypted file.
#[wasm_bindgen(js_name = decryptAttachment)]
pub fn decrypt_attachment(cipher_json: &str, id: &str, data: &[u8]) -> Result<Vec<u8>, JsError> {
    api::decrypt_attachment(cipher_json, id, data).map_err(js)
}

/// Output: `{"key", "fileName", "data"}` (data: encrypted body, base64).
#[wasm_bindgen(js_name = encryptAttachment)]
pub fn encrypt_attachment(
    cipher_json: &str,
    file_name: &str,
    data: &[u8],
) -> Result<String, JsError> {
    api::encrypt_attachment(cipher_json, file_name, data).map_err(js)
}

/// `wrappedKey`: the send's `key` field. Returns the encrypted file body to upload.
#[wasm_bindgen(js_name = encryptSendFile)]
pub fn encrypt_send_file(wrapped_key: &str, data: &[u8]) -> Result<Vec<u8>, JsError> {
    api::encrypt_send_file(wrapped_key, data).map_err(js)
}

/// `input`: base32 secret, `otpauth://` or `steam://` URI. Returns `{"code","period","remaining"}`.
#[wasm_bindgen]
pub fn totp(input: &str, unix_ms: f64) -> Result<String, JsError> {
    totp::totp(input, unix_ms).map_err(js)
}

/// A saved URI's "Regular expression" match against a page URL, case-insensitive. The pattern is the
/// user's, the URL the page's: regex-lite runs in linear time, where a backtracking engine could hang on
/// `(a+)+$`. An invalid pattern matches nothing.
#[wasm_bindgen(js_name = regexTest)]
pub fn regex_test(pattern: &str, text: &str) -> bool {
    regex_lite::RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
        .is_ok_and(|r| r.is_match(text))
}

#[wasm_bindgen(js_name = generatePassword)]
pub fn generate_password(options_json: &str) -> Result<String, JsError> {
    generator::generate(options_json).map_err(js)
}

#[cfg(feature = "register")]
#[wasm_bindgen(js_name = makeRegistrationKeys)]
pub fn make_registration_keys(handle: u32) -> Result<String, JsError> {
    api::make_registration_keys(handle).map_err(js)
}

#[cfg(test)]
mod tests {
    use super::regex_test;

    #[test]
    fn regex_test_is_linear_case_insensitive_and_fails_closed() {
        assert!(regex_test(
            r"^https://([a-z]+\.)?example\.com/",
            "HTTPS://www.Example.com/x"
        ));
        assert!(!regex_test("([", "https://example.com"));
        // Exponential for a backtracking engine; regex-lite answers at once.
        let url = format!("https://example.com/{}!", "a".repeat(5000));
        assert!(!regex_test("^https://example.com/(a+)+$", &url));
    }
}
