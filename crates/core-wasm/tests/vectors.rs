//! Contract test (a): crypto parity with bitwarden/sdk-internal `test-vectors/` at the rev pinned
//! in upstream.lock. The vectors are not copied into this repo; `tools/fetch-test-vectors.sh`
//! downloads them and `WARREN_TEST_VECTORS` points at the directory.

use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use warren_core_wasm::api;

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

fn vectors_dir() -> Option<PathBuf> {
    // Relative paths are relative to the workspace root (cargo runs tests from the crate dir).
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(std::env::var_os("WARREN_TEST_VECTORS")?);
    assert!(
        dir.join("users").is_dir(),
        "WARREN_TEST_VECTORS={} has no users/ dir",
        dir.display()
    );
    Some(dir)
}

fn ci<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    o.iter()
        .find(|(kk, _)| kk.eq_ignore_ascii_case(k))
        .map(|(_, v)| v)
}

fn kdf(v: &Value) -> bitwarden_kdf::Kdf {
    bitwarden_kdf::parse(v)
}

mod bitwarden_kdf {
    use serde_json::Value;
    pub struct Kdf(pub u8, pub u32, pub u32, pub u32);
    pub fn parse(v: &Value) -> Kdf {
        let (name, p) = v.as_object().unwrap().iter().next().unwrap();
        let n = |k: &str| p.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
        match name.to_ascii_lowercase().as_str() {
            "pbkdf2" => Kdf(0, n("iterations"), 0, 0),
            "argon2id" => Kdf(1, n("iterations"), n("memory"), n("parallelism")),
            other => panic!("unknown kdf {other}"),
        }
    }
}

const ENCRYPTED_PATHS: &[&str] = &[
    "name",
    "notes",
    "login",
    "card",
    "identity",
    "secureNote",
    "sshKey",
    "bankAccount",
    "driversLicense",
    "passport",
    "fields",
    "passwordHistory",
    "attachments",
];

/// No value: null, or an empty string, list or object (the two sides differ in which they write).
fn empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// Every string we produced must equal the upstream plaintext at the same path, and every value upstream has must
/// be there: a field we drop or leave empty is a failure too.
fn compare(ours: &Value, expected: &Value, path: &str, errs: &mut Vec<String>) {
    match (ours, expected) {
        (Value::String(a), Value::String(b)) => {
            if a != b {
                errs.push(format!("{path}: got {a:?}, want {b:?}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                // Attachment keys stay encrypted (they wrap binary keys), upstream shows them decrypted.
                if k.eq_ignore_ascii_case("key") {
                    continue;
                }
                match ci(b, k) {
                    Some(e) => compare(v, e, &format!("{path}.{k}"), errs),
                    None if v.is_null() => {}
                    None => errs.push(format!("{path}.{k}: missing upstream")),
                }
            }
            for (k, e) in b {
                if !empty(e) && !k.eq_ignore_ascii_case("key") && ci(a, k).is_none() {
                    errs.push(format!("{path}.{k}: missing, want {e}"));
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                errs.push(format!("{path}: len {} vs {}", a.len(), b.len()));
            }
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                compare(x, y, &format!("{path}[{i}]"), errs);
            }
        }
        (a, b) if empty(a) && empty(b) => {}
        (Value::Null, b) => errs.push(format!("{path}: got null, want {b}")),
        (a, Value::Null) => errs.push(format!("{path}: got {a}, want null")),
        (a, b) if a == b => {}
        (a, b) => errs.push(format!("{path}: got {a}, want {b}")),
    }
}

#[test]
fn user_vectors_unlock_and_decrypt() {
    let Some(dir) = vectors_dir() else {
        eprintln!("WARREN_TEST_VECTORS not set; skipping (run tools/fetch-test-vectors.sh)");
        return;
    };
    let mut checked = 0;
    let mut report = Vec::new();
    // A V2 account's signed security state, for the next V2 vector to try as its own.
    let mut other_v2_state: Option<Value> = None;
    for entry in fs::read_dir(dir.join("users")).unwrap() {
        let path = entry.unwrap().path();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let name = v["name"].as_str().unwrap().to_owned();
        let Some(mp) = v["unlockMethods"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|m| m.get("masterPasswordUnlock"))
        else {
            report.push(format!("{name}: skipped (no master password unlock)"));
            continue;
        };
        let unlock = &mp["master_password_unlock"];
        let password = mp["password"].as_str().unwrap();
        let salt = unlock["salt"].as_str().unwrap();
        let bitwarden_kdf::Kdf(t, i, m, p) = kdf(&unlock["kdf"]);

        let k = api::kdf_from_params(t, i, m, p).unwrap();
        let h = api::derive_master_key(password, salt, &k).unwrap();
        let hash = api::make_auth_hash(h, password, false).unwrap();
        assert_eq!(
            hash,
            v["masterPasswordAuthenticationHash"].as_str().unwrap(),
            "{name}: auth hash"
        );

        let state = &v["account"]["accountCryptographicState"];
        let user_key = unlock["masterKeyWrappedUserKey"].as_str().unwrap();
        // A V2 account opens with its whole signed state (store.ts), the shape the extension keeps.
        let keys = match (state.get("V1"), state.get("V2")) {
            (Some(v1), _) => v1["private_key"].as_str().unwrap().to_owned(),
            (_, Some(v2)) => {
                let s = |k: &str| v2[k].clone();
                let keys = serde_json::json!({ "privateKey": s("private_key"), "signingKey": s("signing_key"),
                    "signedPublicKey": s("signed_public_key"), "securityState": s("security_state") });
                // Without the state, or with another account's signed state, the account does not open.
                assert!(
                    api::unlock_user_key(h, user_key, s("private_key").as_str()).is_err(),
                    "{name}: downgrade"
                );
                if let Some(other) = &other_v2_state {
                    let mut swapped = keys.clone();
                    swapped["securityState"] = other.clone();
                    assert!(
                        api::unlock_user_key(h, user_key, Some(&swapped.to_string())).is_err(),
                        "{name}: swapped state"
                    );
                }
                other_v2_state = Some(s("security_state"));
                keys.to_string()
            }
            _ => panic!("{name}: no account state"),
        };
        api::unlock_user_key(h, user_key, Some(&keys))
            .unwrap_or_else(|e| panic!("{name}: unlock: {e}"));
        let want_version = v["account"]["securityVersion"].as_u64().unwrap_or(1);
        assert_eq!(
            api::security_version(),
            Some(want_version),
            "{name}: security version"
        );

        for c in v["vault"]["ciphers"].as_array().unwrap() {
            let id = c["encrypted"]["id"].as_str().unwrap();
            let out: Value =
                serde_json::from_str(&api::decrypt_cipher(&c["encrypted"].to_string()).unwrap())
                    .unwrap();
            let mut errs = Vec::new();
            for p in ENCRYPTED_PATHS {
                match (
                    ci(out.as_object().unwrap(), p),
                    ci(c["decrypted"].as_object().unwrap(), p),
                ) {
                    (Some(a), Some(b)) => compare(a, b, p, &mut errs),
                    (None, Some(b)) if !empty(b) => errs.push(format!("{p}: missing, want {b}")),
                    _ => {}
                }
            }
            assert!(errs.is_empty(), "{name}/{id}:\n{}", errs.join("\n"));

            // Round trip: re-encrypt our plaintext view and decrypt it again.
            let mut reenc_in = out.clone();
            reenc_in
                .as_object_mut()
                .unwrap()
                .insert("key".into(), c["encrypted"]["key"].clone());
            let reenc = api::encrypt_cipher(&reenc_in.to_string(), false).unwrap();
            let back: Value = serde_json::from_str(&api::decrypt_cipher(&reenc).unwrap()).unwrap();
            // A V2 account's personal item goes back as a blob (`reenc` holds `data`), a V1 one field by field.
            let reenc: Value = serde_json::from_str(&reenc).unwrap();
            assert_eq!(
                reenc.get("data").is_some(),
                c["blobEncrypted"] == true,
                "{name}/{id}: written format"
            );
            let mut errs = Vec::new();
            compare(&back, &out, "roundtrip", &mut errs);
            assert!(
                errs.is_empty(),
                "{name}/{id} roundtrip:\n{}",
                errs.join("\n")
            );
            checked += 1;
        }
        // Every other way into the session, and every other key it wraps, works with this account's user key too
        // (for a V2 account an XAES-256-GCM one): PIN, biometric (PRF), login with a device, Sends, attachments.
        let quick = api::kdf_from_params(0, 5_000, 0, 0).unwrap();
        let pin = api::pin_protect_user_key("1234", salt, &quick).unwrap();
        let prf = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // 32 bytes
        let prf_wrapped = api::prf_protect_user_key(prf).unwrap();
        let send = api::encrypt_send(r#"{"type":0,"name":"n","text":{"text":"secret"}}"#).unwrap();
        let sends = api::decrypt_send_list(&format!("[{send}]")).unwrap();
        assert!(sends.contains(r#""secret""#), "{name}: send");
        let mut item =
            serde_json::json!({ "type": 2, "name": "with file", "secureNote": { "type": 0 } });
        item =
            serde_json::from_str(&api::encrypt_cipher(&item.to_string(), true).unwrap()).unwrap();
        let att: Value = serde_json::from_str(
            &api::encrypt_attachment(&item.to_string(), "f.txt", b"body").unwrap(),
        )
        .unwrap();
        item["attachments"] =
            serde_json::json!([{ "id": "a", "key": att["key"], "fileName": att["fileName"] }]);
        let body = base64_decode(att["data"].as_str().unwrap());
        assert_eq!(
            api::decrypt_attachment(&item.to_string(), "a", &body).unwrap(),
            b"body",
            "{name}: attachment"
        );
        let opened: Value =
            serde_json::from_str(&api::decrypt_cipher(&item.to_string()).unwrap()).unwrap();
        assert_eq!(
            opened["attachments"][0]["fileName"], "f.txt",
            "{name}: attachment name"
        );
        // An organization key shared to this account's public key opens with its private key (V2: COSE-wrapped).
        let org_key =
            api::auth_request_approve(v["rawCryptographicState"]["publicKey"].as_str().unwrap())
                .unwrap();
        assert_eq!(
            api::set_org_keys(&serde_json::json!({ "org": org_key }).to_string()).unwrap(),
            1,
            "{name}: org key"
        );
        let req: Value = serde_json::from_str(&api::auth_request_create(salt).unwrap()).unwrap();
        let approved = api::auth_request_approve(req["publicKey"].as_str().unwrap()).unwrap();
        api::auth_request_unlock(&approved, Some(&keys))
            .unwrap_or_else(|e| panic!("{name}: device login: {e}"));
        api::lock();
        api::unlock_with_pin("1234", salt, &quick, &pin, Some(&keys))
            .unwrap_or_else(|e| panic!("{name}: PIN: {e}"));
        api::lock();
        api::unlock_with_prf(prf, &prf_wrapped, Some(&keys))
            .unwrap_or_else(|e| panic!("{name}: PRF: {e}"));
        assert_eq!(
            api::security_version(),
            Some(want_version),
            "{name}: version after PRF unlock"
        );
        api::lock();

        report.push(format!("{name}: ok"));
    }
    eprintln!("{}", report.join("\n"));
    assert!(checked > 0, "no ciphers checked");
}
