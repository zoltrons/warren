//! Blob-encrypted ciphers (`data` = a sealed `CipherBlob`), as the Bitwarden SDK writes every personal item of an
//! account whose security version is 2 or higher (bitwarden-vault `should_use_blob_encryption`).
//!
//! Format (bitwarden-vault `cipher/blob`, ported for reading; see docs/LICENSING.md): `data` is the JSON
//! `{"format_version":1,"wrapped_cek":<EncString>,"envelope":<DataEnvelope>}`. The content-encryption key is wrapped by
//! the cipher key (or the user/organization key when the item has none) and opens a `DataEnvelope` in the `VaultItem`
//! namespace, which holds the CBOR of `{"version":"1","content":CipherBlobV1}`.
//!
//! We do not model `CipherBlobV1` as structs: the content is read as JSON and mapped onto the field names the rest of
//! Warren uses (the server's legacy cipher shape), the same model as the other cipher code (cipher.rs).

use bitwarden_crypto::{
    EncString, KeyStore, SymmetricCryptoKey, generate_versioned_sealable, key_slot_ids,
    safe::{DataEnvelope, DataEnvelopeNamespace, SealableData, SealableVersionedData},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::api::{Result, err};

key_slot_ids! {
    #[symmetric]
    enum SymmetricIds {
        #[local]
        Local(LocalId),
    }
    #[private]
    enum PrivateIds {
        #[local]
        Local(LocalId),
    }
    #[signing]
    enum SigningIds {
        #[local]
        Local(LocalId),
    }
    Ids => SymmetricIds, PrivateIds, SigningIds;
}

/// `CipherBlobV1`, kept as JSON.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(transparent)]
struct CipherBlobV1(Value);
impl SealableData for CipherBlobV1 {}

generate_versioned_sealable!(
    CipherBlob,
    DataEnvelopeNamespace::VaultItem,
    [CipherBlobV1 => "1"]
);

#[derive(Deserialize)]
struct Sealed {
    format_version: u8,
    wrapped_cek: EncString,
    envelope: DataEnvelope,
}

/// Vaultwarden's test for a blob (`format_version` in `data`); it sends `data` as a JSON string, the SDK as an object.
pub(crate) fn is_blob(data: &Value) -> bool {
    match data {
        Value::String(s) => {
            serde_json::from_str::<Value>(s).is_ok_and(|v| v.get("format_version").is_some())
        }
        v => v.get("format_version").is_some(),
    }
}

/// The blob's `CipherBlobV1` content, opened with `key` (the cipher key, or the user/organization key).
fn unseal(key: &SymmetricCryptoKey, data: &Value) -> Result<Map<String, Value>> {
    let sealed: Sealed = match data {
        Value::String(s) => serde_json::from_str(s),
        v => serde_json::from_value(v.clone()),
    }
    .map_err(|_| "blob: not a sealed cipher blob")?;
    if sealed.format_version != 1 {
        return Err(format!(
            "blob: unsupported format version {}",
            sealed.format_version
        ));
    }
    let store = KeyStore::<Ids>::default();
    let mut ctx = store.context_mut();
    let wrapping = ctx.add_local_symmetric_key(key.clone());
    let CipherBlob::CipherBlobV1(CipherBlobV1(content)) = sealed
        .envelope
        .unseal_with_wrapping_key(&wrapping, &sealed.wrapped_cek, &mut ctx)
        .map_err(err)?;
    match content {
        Value::Object(o) => Ok(o),
        _ => Err("blob: content is not an object".into()),
    }
}

/// `typeData.type` → the cipher type and the container its fields go in.
const TYPES: &[(&str, u8, &str)] = &[
    ("login", 1, "login"),
    ("secureNote", 2, "secureNote"),
    ("card", 3, "card"),
    ("identity", 4, "identity"),
    ("sshKey", 5, "sshKey"),
    ("bankAccount", 6, "bankAccount"),
    ("driversLicense", 7, "driversLicense"),
    ("passport", 8, "passport"),
];

/// Maps a `CipherBlobV1` onto the plaintext fields of a legacy cipher: `name`, `notes`, `type`, the type's container,
/// `fields`, `passwordHistory`. Field names differ in three places, as in bitwarden-vault's blob conversions:
/// `secureNoteType` is the note's `type`, `fingerprint` is the SSH key's `keyFingerprint`, and a passkey's `counter`
/// and `discoverable` are strings in the legacy model.
fn to_legacy(mut blob: Map<String, Value>) -> Result<Map<String, Value>> {
    let Some(Value::Object(mut data)) = blob.remove("typeData") else {
        return Err("blob: no typeData".into());
    };
    let tag = data.remove("type");
    let &(_, kind, container) = TYPES
        .iter()
        .find(|(t, ..)| tag.as_ref().and_then(Value::as_str) == Some(*t))
        .ok_or_else(|| format!("blob: unknown item type {tag:?}"))?;
    match kind {
        2 => rename(&mut data, "secureNoteType", "type"),
        5 => rename(&mut data, "fingerprint", "keyFingerprint"),
        1 => {
            if let Some(Value::Array(creds)) = data.get_mut("fido2Credentials") {
                for c in creds.iter_mut().filter_map(Value::as_object_mut) {
                    for k in ["counter", "discoverable"] {
                        if let Some(v) = c.get_mut(k).filter(|v| !v.is_string()) {
                            *v = Value::String(v.to_string());
                        }
                    }
                }
            }
        }
        _ => {}
    }
    let mut out = Map::new();
    out.insert("type".into(), json!(kind));
    for k in ["name", "notes", "fields", "passwordHistory"] {
        out.insert(k.into(), blob.remove(k).unwrap_or(Value::Null));
    }
    out.insert(container.into(), Value::Object(data));
    Ok(out)
}

fn rename(o: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(v) = o.remove(from) {
        o.insert(to.into(), v);
    }
}

/// The plaintext fields of a blob-encrypted cipher (`data`), opened with its cipher key or the user/organization key.
pub(crate) fn open(key: &SymmetricCryptoKey, data: &Value) -> Result<Map<String, Value>> {
    to_legacy(unseal(key, data)?)
}

#[cfg(test)]
pub(crate) mod tests {
    use bitwarden_crypto::{KeyStoreContext, SymmetricKeyAlgorithm};

    use super::*;

    /// Seals `content` like bitwarden-vault does, under `key`.
    pub(crate) fn seal(key: &SymmetricCryptoKey, content: Value) -> String {
        let store = KeyStore::<Ids>::default();
        let mut ctx: KeyStoreContext<Ids> = store.context_mut();
        let wrapping = ctx.add_local_symmetric_key(key.clone());
        let (envelope, wrapped_cek) = DataEnvelope::seal_with_wrapping_key(
            CipherBlob::from(CipherBlobV1(content)),
            &wrapping,
            &mut ctx,
        )
        .unwrap();
        json!({ "format_version": 1, "wrapped_cek": wrapped_cek.to_string(), "envelope": String::from(envelope) })
            .to_string()
    }

    // Envelopes and their content-encryption keys recorded by bitwarden-vault (cipher/blob/v1.rs test vectors at the
    // rev in upstream.lock): one per item type, so a schema change upstream shows up here.
    const SECURE_NOTE: (&str, &str) = (
        "pQEEAlApYxU9rgfIc9v9sHuglhkKAzoAARFvBIEEIFggDKYmieFA7a0UoOMAt4BErOpk7VfwZI8Dk0Yc9FxFzWIB",
        "g1hLpQE6AAERbwN4I2FwcGxpY2F0aW9uL3guYml0d2FyZGVuLmNib3ItcGFkZGVkBFApYxU9rgfIc9v9sHuglhkKOgABOIECOgABOIABoQVYGMihknYX7mrmC03/w0V7rTMij2+q237p21h2H2Sq0hnlzZ4ka8yMW1yFOOMSt5ZS3tNQxzT07qeeY10tAeczgizA2g5AvmIQJdXK+7KR5mP3zk5VaVfGjC9mZUUFXwIAXsxC16HUII7Z1Iwhpd+MrJDf+itZGFVd07ExaXkH5+MjfaXhJqXBSxAStCG5zLGsEg==",
    );

    const LOGIN: (&str, &str) = (
        "pQEEAlClJ9tO9x8fN2JVe5N8uzAaAzoAARFvBIEEIFggZwJXkLK7A6Sy5Y9+dacJrzCg9bo4RMRxXaRGDWYfbTYB",
        "g1hLpQE6AAERbwN4I2FwcGxpY2F0aW9uL3guYml0d2FyZGVuLmNib3ItcGFkZGVkBFClJ9tO9x8fN2JVe5N8uzAaOgABOIECOgABOIABoQVYGNYP1rgAT3D2T6q2lGTRjIPHR2IELUDWE1kC2erlZM4Dqyeew1VlDkdXnZIE+t2g4SJh8IFSHo9WuzmyY+qC+V9cuGW3QHt+sg7pfZ5kQBh40U9uxUcxOHdVF3jQhcAmgB9abShR68u41NMDwwLSafG8PLzsUfhhxpCG0+ZuOda3tFVM1y5TyiDPJBBoJECuYK/K/1RLNAWAy5AU98yI0RgdK0MHxpoOqdSC8dXXu6fGgON7XLQWkkceFWILp0o51/c7OvdJ3B1nCiCIZjwAyS96+oWOzLrsPaGkBjqedBCi5iwelzLOttXk6nrzE/FfC0PkeeSsPSr9UdXBbeuUSK7wKtir9Lx/gtJ4sMPFidtTNdXCcDT9RA7y21h+3+wHQgGSlOGRigXFgXWi5ajSPCs9zLn7ERoG4BZ4IHa6EMSJbGH1pANW+Ibg4aadBF7LzOi/BZx2oZ/6z54XfAfqb44FR3/XXdNFHosPH9IH7CkKbNvLTuGrOTk9S998qFDNkWeGthrDYclaYSFktSHULvmHhSPadRL4uM6254HTmSjTAG6FDhhqdJU3SvoifrvBeHqjEP7F5R+zjVQol+JUcs/ExwmlrxXETOTzGyC/++FflZyPIUnH9U7ZqXhiYGd0ZvcyrnrnieehYToWFdwFR9ho+6h9hB/SCjhGudP5CRPZDL9GkNAUS5+pAd4ZC19fDjWpwMnEbgPTuthXKl6YRHxxCV+xpc9jncVQt9zF31e0bSIP7kVcdmlgjXaV6Nmd3aZ+PqeJnj27gCxG2tZkMimdJmEgxkL/cfvNHENg43+rpnV2mCTrCAO/X+RDGKdi7SIzsLesPVXVHEZCM4UBv2v+S/vpDFC3ie09cz525PCgt/7Je68k8S5WsTwKVeL0+T/ysqDo7wJvFSToY2G/LOGnBYMUYcCLfJGQbD8g2xI3oC+go8kcyVDJv+936/MkAYSxnvZDrMr30zEZaNm5YBh8cRqKr4MxOjJBk1XWjwDNsSQrDw==",
    );
    const SSH_KEY: (&str, &str) = (
        "pQEEAlApE2RsnNwb3+3FyIr/kcfWAzoAARFvBIEEIFggDk3igU6wYnicl6jRSYILSaPlDWYCjnRUqMLdqfPkVKAB",
        "g1hLpQE6AAERbwN4I2FwcGxpY2F0aW9uL3guYml0d2FyZGVuLmNib3ItcGFkZGVkBFApE2RsnNwb3+3FyIr/kcfWOgABOIECOgABOIABoQVYGHPwqnuSuDHdwTg3twT5B0b3AXKVK+cySVkBSzorjdnfAdt1aNM32x3BPUg4QMkR99SQum3yc4eIT5eqi2FZjHyvEVPMwxfcWqg26g8UTc3dsRW57RYRF4ajx4+MGcJj+wWTrI8jPmthhLAnEHT11eC2YjYIW1INWKGFJTKnTjwHw1LTVJvEzA9MAZRk2y2NC+qkkdDM3wKmhl4PqoEPmt/x6qBjlR5+rlA4rUqkm9ja+NqqEbz8McGXBw8QWOh99/xE1PorFk7S+o9LW1Kcv1/GL+1wv6X7tTo1dYVYa2uCo9Hp9C8D5zXz/iVLm9w98NQFZQlteO8yibEOp+F/VNpgpsmZjOQzJ6wf0hKabFF2eXIUJ2RT1vJT+zUdcfc+TMkypaBbJEagmAiEBnZFcxVEhQ3tn1ZyJFRUcMzm91azIHQMmQ9cS6h/SqTGFF3z+q0H4+8w2S+yl+D5/OVWQHKcSOFvsPA=",
    );

    #[test]
    fn reads_a_login_recorded_by_the_sdk() {
        let l = open_recorded(LOGIN);
        assert_eq!(
            (l["type"].clone(), l["name"].clone()),
            (json!(1), json!("Test Login"))
        );
        let login = &l["login"];
        assert_eq!(login["username"], "testuser@example.com");
        assert_eq!(login["password"], "p@ssw0rd123");
        assert_eq!(login["uris"][0]["uri"], "https://example.com/login");
        assert_eq!(login["uris"][0]["match"], 0);
        assert_eq!(login["totp"], "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP");
        assert_eq!(login["autofillOnPageLoad"], true);
        let p = &login["fido2Credentials"][0];
        assert_eq!(
            (p["credentialId"].clone(), p["rpId"].clone()),
            (json!("credential-id-123"), json!("example.com"))
        );
        assert_eq!(
            (p["counter"].clone(), p["discoverable"].clone()),
            (json!("42"), json!("true"))
        );
        assert_eq!(
            l["fields"][0],
            json!({ "name": "Custom Field", "value": "custom-value", "type": 3, "linkedId": 100 })
        );
        assert_eq!(l["passwordHistory"][0]["password"], "old-password-1");
    }

    #[test]
    fn reads_an_ssh_key_recorded_by_the_sdk() {
        let k = open_recorded(SSH_KEY);
        assert_eq!(k["type"], 5);
        assert_eq!(
            k["sshKey"]["keyFingerprint"],
            "SHA256:abcdefghijklmnopqrstuvwxyz012345678901234567"
        );
        assert_eq!(
            k["sshKey"]["publicKey"],
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@example.com"
        );
    }

    fn open_recorded((cek, envelope): (&str, &str)) -> Map<String, Value> {
        let store = KeyStore::<Ids>::default();
        let mut ctx = store.context_mut();
        let cek =
            ctx.add_local_symmetric_key(SymmetricCryptoKey::try_from(cek.to_string()).unwrap());
        let env: DataEnvelope = envelope.parse().unwrap();
        let CipherBlob::CipherBlobV1(CipherBlobV1(Value::Object(c))) =
            env.unseal(cek, &mut ctx).unwrap()
        else {
            panic!("not an object")
        };
        to_legacy(c).unwrap()
    }

    #[test]
    fn reads_a_secure_note_recorded_by_the_sdk() {
        let n = open_recorded(SECURE_NOTE);
        assert_eq!(n["name"], "Test Secure Note");
        assert_eq!(n["notes"], "Some notes");
        assert_eq!(n["type"], 2);
        assert_eq!(n["secureNote"], json!({ "type": 0 }));
    }

    #[test]
    fn maps_every_type_and_the_renamed_fields() {
        let key = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
        let login = json!({ "version": "1", "content": {
            "name": "n", "notes": null,
            "typeData": { "type": "login", "username": "u", "password": "p",
                "uris": [{ "uri": "https://a.test", "match": 0 }],
                "fido2Credentials": [{ "credentialId": "c", "counter": 7, "discoverable": true }] },
            "fields": [{ "name": "f", "value": "v", "type": 0, "linkedId": null }],
            "passwordHistory": [{ "password": "old", "lastUsedDate": "2024-01-01T00:00:00Z" }],
        }});
        let CipherBlob::CipherBlobV1(CipherBlobV1(content)) =
            serde_json::from_value(login).unwrap();
        let out = open(&key, &json!(seal(&key, content))).unwrap();
        assert_eq!(out["type"], 1);
        assert_eq!(out["login"]["uris"][0]["uri"], "https://a.test");
        assert_eq!(out["login"]["fido2Credentials"][0]["counter"], "7");
        assert_eq!(out["login"]["fido2Credentials"][0]["discoverable"], "true");
        assert_eq!(out["fields"][0]["value"], "v");
        assert_eq!(out["passwordHistory"][0]["password"], "old");

        let ssh = json!({ "name": "k", "typeData": { "type": "sshKey", "privateKey": "a", "publicKey": "b", "fingerprint": "c" } });
        let out = open(&key, &json!(seal(&key, ssh))).unwrap();
        assert_eq!(
            (out["type"].clone(), out["sshKey"]["keyFingerprint"].clone()),
            (json!(5), json!("c"))
        );
        for (t, n) in [
            ("card", 3),
            ("identity", 4),
            ("bankAccount", 6),
            ("driversLicense", 7),
            ("passport", 8),
        ] {
            let out = open(
                &key,
                &json!(seal(
                    &key,
                    json!({ "name": "x", "typeData": { "type": t } })
                )),
            )
            .unwrap();
            assert_eq!(out["type"], n, "{t}");
            assert!(out[t].is_object(), "{t}");
        }
    }

    #[test]
    fn refuses_a_wrong_key_a_bad_version_and_an_unknown_type() {
        let key = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
        let other = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
        let sealed = seal(&key, json!({ "name": "x", "typeData": { "type": "card" } }));
        assert!(open(&other, &json!(sealed)).is_err());
        let mut v: Value = serde_json::from_str(&sealed).unwrap();
        v["format_version"] = json!(2);
        assert!(open(&key, &v).is_err());
        let unknown = seal(
            &key,
            json!({ "name": "x", "typeData": { "type": "future" } }),
        );
        assert!(open(&key, &json!(unknown)).is_err());
    }
}
