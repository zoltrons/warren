//! Contract test (a): crypto parity with bitwarden/sdk-internal `test-vectors/` at the rev pinned
//! in upstream.lock. The vectors are not copied into this repo; `tools/fetch-test-vectors.sh`
//! downloads them and `WARREN_TEST_VECTORS` points at the directory.

use std::{fs, path::PathBuf};

use serde_json::{Map, Value};
use warren_core_wasm::api;

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
        let private = state
            .get("V1")
            .or_else(|| state.get("V2"))
            .and_then(|s| s["private_key"].as_str());
        api::unlock_user_key(
            h,
            unlock["masterKeyWrappedUserKey"].as_str().unwrap(),
            private,
        )
        .unwrap_or_else(|e| panic!("{name}: unlock: {e}"));

        for c in v["vault"]["ciphers"].as_array().unwrap() {
            let id = c["encrypted"]["id"].as_str().unwrap();
            if c["blobEncrypted"].as_bool() == Some(true) {
                report.push(format!(
                    "{name}/{id}: skipped (blob-encrypted cipher, not implemented)"
                ));
                continue;
            }
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
            let reenc = api::encrypt_cipher(&reenc_in.to_string()).unwrap();
            let back: Value = serde_json::from_str(&api::decrypt_cipher(&reenc).unwrap()).unwrap();
            let mut errs = Vec::new();
            compare(&back, &out, "roundtrip", &mut errs);
            assert!(
                errs.is_empty(),
                "{name}/{id} roundtrip:\n{}",
                errs.join("\n")
            );
            checked += 1;
        }
        api::lock();
        report.push(format!("{name}: ok"));
    }
    eprintln!("{}", report.join("\n"));
    assert!(checked > 0, "no ciphers checked");
}
