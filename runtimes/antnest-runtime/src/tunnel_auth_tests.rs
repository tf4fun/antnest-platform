use crate::tunnel_auth::{Descriptor, decode, read_directory};
use antnest_runtime_tunnel::Peer;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

pub(crate) fn fixture() -> (Descriptor, Vec<u8>) {
    let value = serde_json::json!({"key_id":"rtk_0102030405060708090a0b0c0d0e0f10", "runtime_private_key":URL_SAFE_NO_PAD.encode([11;32]), "egress_public_key":URL_SAFE_NO_PAD.encode(Peer::public_key([29;32])), "preshared_key":URL_SAFE_NO_PAD.encode([53;32])});
    let raw = serde_json::to_vec(&value).unwrap();
    let descriptor = Descriptor {
        key_id: value["key_id"].as_str().unwrap().into(),
        keys_file: "/run/antnest-auth/tunnel.json".into(),
        keys_digest: crate::tunnel_auth::digest(&raw),
    };
    (descriptor, raw)
}
#[test]
fn private_bootstrap_rejects_digest_identity_unknown_and_noncanonical_keys() {
    let (descriptor, raw) = fixture();
    assert!(decode(&raw, &descriptor).is_ok());
    let mut changed = raw.clone();
    changed[5] ^= 1;
    assert!(decode(&changed, &descriptor).is_err());
    for (field, value) in [
        (
            "runtime_private_key",
            serde_json::json!(URL_SAFE_NO_PAD.encode([0; 32])),
        ),
        ("preshared_key", serde_json::json!("bad")),
        (
            "key_id",
            serde_json::json!("rtk_00000000000000000000000000000000"),
        ),
        ("extra", serde_json::json!("untrusted")),
    ] {
        let mut body: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        body[field] = value;
        let mutated = serde_json::to_vec(&body).unwrap();
        let mut d = descriptor.clone();
        d.keys_digest = crate::tunnel_auth::digest(&mutated);
        assert!(decode(&mutated, &d).is_err());
    }
}
#[test]
fn private_bootstrap_checks_opened_file_owner_mode_and_symlink() {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt as _, symlink};
    let (descriptor, raw) = fixture();
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.path().join("tunnel.json");
    fs::write(&path, raw).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let uid = nix::unistd::geteuid().as_raw();
    let gid = nix::unistd::getegid().as_raw();
    assert!(read_directory(root.path(), &descriptor, uid, gid).is_ok());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_directory(root.path(), &descriptor, uid, gid).is_err());
    fs::remove_file(&path).unwrap();
    symlink("outside", &path).unwrap();
    assert!(read_directory(root.path(), &descriptor, uid, gid).is_err());
}
