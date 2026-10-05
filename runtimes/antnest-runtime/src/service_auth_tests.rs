use serde_json::Value;

use crate::service_auth::{AdmissionError, Receiver, valid_token, validate_http_mode};

fn fixtures() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/platform/service-token-fixtures.json"
    )))
    .unwrap()
}

#[test]
fn canonical_tokens_match_every_shared_vector() {
    for case in fixtures()["token_vectors"].as_array().unwrap() {
        assert_eq!(
            valid_token(case["token"].as_str().unwrap()),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn bounded_duplicate_safe_hash_profiles_match_every_shared_vector() {
    for case in fixtures()["configuration_vectors"].as_array().unwrap() {
        let parsed = Receiver::parse(
            case["callers_json"].as_str().unwrap().as_bytes(),
            case["receiver"].as_str().unwrap(),
            case["self_allowed"].as_bool().unwrap(),
        );
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
    for raw in [
        b"{\"agent-controller\":[\"\xff\"]}".as_slice(),
        &[b' '; 8193],
    ] {
        assert!(Receiver::parse(raw, "antnest-runtime", false).is_err());
    }
}

#[test]
fn whole_header_profile_matches_shared_vectors_with_runtime_error_name() {
    let fixture = fixtures();
    for case in fixture["header_vectors"].as_array().unwrap() {
        let receiver = Receiver::parse(
            fixture["receiver_configurations"][case["configuration"].as_str().unwrap()]
                .to_string()
                .as_bytes(),
            "runtime-controller",
            false,
        )
        .unwrap();
        let fields = case["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| {
                (
                    field["name"].as_str().unwrap(),
                    field["value"].as_str().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let allowed = case["allowed_callers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        let result = receiver.authorize_fields(&fields, &allowed);
        match case["expected"]["http_status"].as_u64().unwrap() {
            200 => assert_eq!(
                result.unwrap(),
                case["expected"]["caller"].as_str().unwrap(),
                "{}",
                case["name"]
            ),
            401 => assert_eq!(
                result.unwrap_err(),
                AdmissionError::Unauthenticated,
                "{}",
                case["name"]
            ),
            403 => assert_eq!(
                result.unwrap_err(),
                AdmissionError::Forbidden,
                "{}",
                case["name"]
            ),
            _ => panic!("unknown shared outcome"),
        }
    }
}

#[test]
fn native_http_capability_never_downgrades_tls_or_mtls() {
    for case in fixtures()["mode_vectors"].as_array().unwrap() {
        let result = validate_http_mode(
            case["mode"].as_str(),
            case["allow_insecure_transport"].as_str(),
        );
        let supported = case["valid"].as_bool().unwrap()
            && case["mode"] == "token"
            && case["allow_insecure_transport"] == "true";
        assert_eq!(result.is_ok(), supported, "{}", case["name"]);
    }
}

#[test]
fn receiver_directory_checks_opened_files_permissions_owner_and_complete_digest() {
    use std::fs::{self, OpenOptions};
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _, symlink};

    use sha2::{Digest as _, Sha256};

    use crate::service_auth::{BootstrapDescriptor, read_receiver_directory};

    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let raw = br#"{"runtime-controller":["sha256:ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0"],"agent-acp-service":["sha256:cf0931e168b49e987503caf18af6fe253b6b3d82a81008c3e8e1ee67c7c8dc55"]}"#;
    let descriptor = BootstrapDescriptor {
        connection_id: "rci_00000000000000000000000000000001".into(),
        callers_file: crate::service_auth::CALLERS_FILE.into(),
        receiver_digest: "sha256:".to_owned()
            + &Sha256::digest(raw)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
    };
    let path = root.path().join("callers.json");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(raw)
        .unwrap();
    let uid = nix::unistd::geteuid().as_raw();
    let gid = nix::unistd::getegid().as_raw();
    assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_ok());
    assert!(read_receiver_directory(root.path(), &descriptor, uid.wrapping_add(1), gid).is_err());
    for mode in [0o755, 0o777] {
        fs::set_permissions(root.path(), fs::Permissions::from_mode(mode)).unwrap();
        assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_err());
    }
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(root.path().join("extra"), "unexpected").unwrap();
    assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_err());
    fs::remove_file(root.path().join("extra")).unwrap();
    fs::write(&path, b"{}").unwrap();
    assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_err());
    fs::remove_file(&path).unwrap();
    symlink("elsewhere", &path).unwrap();
    assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_err());
    fs::remove_file(&path).unwrap();
    nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
    assert!(read_receiver_directory(root.path(), &descriptor, uid, gid).is_err());
}

#[test]
fn strict_json_rejects_ambiguous_nested_members_and_non_utf8() {
    use crate::service_auth::valid_json_body;
    for raw in [
        br#"{"method":"tools/list","method":"tools/call"}"#.as_slice(),
        br#"{"params":{"name":"read","\u006eame":"write"}}"#,
        br#"{"params":[{"name":"read","name":"write"}]}"#,
        b"{\"params\":\"\xff\"}",
        b"{} {}",
        b"{} trailing",
        b"\xef\xbb\xbf{}",
    ] {
        assert!(!valid_json_body(raw), "{raw:?}");
    }
    for raw in [
        br#"{"method":"tools/list","params":{}}"#.as_slice(),
        b"[]",
        b"\n{} ",
    ] {
        assert!(valid_json_body(raw));
    }
}

#[test]
fn exact_json_media_rejects_missing_duplicate_and_non_utf8_types() {
    use crate::service_auth::valid_json_media;
    for value in [
        "",
        "text/plain",
        "application/problem+json",
        "application/json, application/json",
        "application/json; charset=latin1",
        "application/json; charset=utf-8; charset=utf-8",
        "application/json; boundary=a",
    ] {
        assert!(!valid_json_media(&[value]), "{value}");
    }
    assert!(!valid_json_media(&[]));
    assert!(!valid_json_media(&["application/json", "application/json"]));
    for value in [
        "application/json",
        "Application/JSON",
        "application/json; charset=UTF-8",
        "application/json; charset=\"utf-8\"",
    ] {
        assert!(valid_json_media(&[value]), "{value}");
    }
}
