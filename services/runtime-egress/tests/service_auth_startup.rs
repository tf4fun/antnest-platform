#[path = "support/pki.rs"]
mod pki;
mod support;

use std::{collections::HashMap, fs};

use antnest_runtime_egress::transport::SecurityConfig;
use pki::Pki;
use rcgen::{ExtendedKeyUsagePurpose, KeyPair, date_time_ymd};
use sha2::{Digest as _, Sha256};

fn token_values(root: &tempfile::TempDir) -> HashMap<String, String> {
    let digest = Sha256::digest(support::workload_token().as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let file = root.path().join("callers.json");
    fs::write(
        &file,
        format!("{{\"agent-controller\":[\"sha256:{hex}\"]}}"),
    )
    .unwrap();
    HashMap::from([
        ("ANTNEST_SERVICE_AUTH_MODE".to_owned(), "token".to_owned()),
        (
            "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT".to_owned(),
            "true".to_owned(),
        ),
        (
            "ANTNEST_SERVICE_AUTH_CALLERS_FILE".to_owned(),
            file.to_string_lossy().into_owned(),
        ),
    ])
}

#[test]
fn startup_mode_is_required_and_plain_http_needs_exact_opt_in() {
    assert!(SecurityConfig::from_values(&HashMap::new()).is_err());
    let root = tempfile::tempdir().unwrap();
    let base = token_values(&root);
    assert!(!SecurityConfig::from_values(&base).unwrap().uses_tls());
    for mode in ["", "TOKEN", " token", "token ", "none", "mtls"] {
        let mut values = base.clone();
        values.insert("ANTNEST_SERVICE_AUTH_MODE".into(), mode.into());
        assert!(SecurityConfig::from_values(&values).is_err(), "{mode}");
    }
    for insecure in [
        None,
        Some("false"),
        Some(""),
        Some(" true"),
        Some("true "),
        Some("TRUE"),
        Some("1"),
    ] {
        let mut values = base.clone();
        match insecure {
            Some(value) => {
                values.insert(
                    "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT".into(),
                    value.into(),
                );
            }
            None => {
                values.remove("ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT");
            }
        }
        assert!(
            SecurityConfig::from_values(&values).is_err(),
            "{insecure:?}"
        );
    }
}

#[test]
fn selected_tls_is_complete_and_never_ignored_with_http_opt_in() {
    let pki = Pki::new();
    let tls = pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    );
    assert!(SecurityConfig::from_values(&tls).unwrap().uses_tls());
    let mut token = token_values(&pki.root);
    token.extend(
        tls.into_iter()
            .filter(|(key, _)| key.starts_with("ANTNEST_TLS_")),
    );
    assert!(SecurityConfig::from_values(&token).unwrap().uses_tls());
    for key in [
        "ANTNEST_TLS_CA_FILE",
        "ANTNEST_TLS_CERT_FILE",
        "ANTNEST_TLS_KEY_FILE",
        "ANTNEST_TLS_SERVER_NAME",
    ] {
        let mut partial = token.clone();
        partial.remove(key);
        assert!(SecurityConfig::from_values(&partial).is_err(), "{key}");
        let mut empty = token.clone();
        empty.insert(key.into(), String::new());
        assert!(SecurityConfig::from_values(&empty).is_err(), "{key}");
    }
    let mut token_tls_only = token.clone();
    token_tls_only.remove("ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT");
    assert!(
        SecurityConfig::from_values(&token_tls_only)
            .unwrap()
            .uses_tls()
    );
}

#[test]
fn startup_verifies_exact_service_uri_server_usage_validity_key_trust_and_dns() {
    for uris in [
        vec![],
        vec!["antnest://service/agent-controller"],
        vec![
            "antnest://service/runtime-egress",
            "antnest://service/runtime-egress",
        ],
        vec!["antnest://service/runtime-egress?extra=1"],
        vec!["spiffe://service/runtime-egress"],
    ] {
        let pki = Pki::new();
        let values = pki.values("mtls", Pki::server_params(&uris));
        assert!(SecurityConfig::from_values(&values).is_err(), "{uris:?}");
    }
    let pki = Pki::new();
    let mut wrong_usage = Pki::server_params(&["antnest://service/runtime-egress"]);
    wrong_usage.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    assert!(SecurityConfig::from_values(&pki.values("mtls", wrong_usage)).is_err());
    let mut expired = Pki::server_params(&["antnest://service/runtime-egress"]);
    expired.not_before = date_time_ymd(2000, 1, 1);
    expired.not_after = date_time_ymd(2001, 1, 1);
    assert!(SecurityConfig::from_values(&pki.values("mtls", expired)).is_err());
    let mut future = Pki::server_params(&["antnest://service/runtime-egress"]);
    future.not_before = date_time_ymd(3000, 1, 1);
    future.not_after = date_time_ymd(3001, 1, 1);
    assert!(SecurityConfig::from_values(&pki.values("mtls", future)).is_err());
    let base = pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    );
    for name in [
        "other.test",
        "127.0.0.1",
        " egress.test",
        "egress.test ",
        "https://egress.test",
    ] {
        let mut values = base.clone();
        values.insert("ANTNEST_TLS_SERVER_NAME".into(), name.into());
        assert!(SecurityConfig::from_values(&values).is_err(), "{name}");
    }
    fs::write(
        base["ANTNEST_TLS_KEY_FILE"].as_str(),
        KeyPair::generate().unwrap().serialize_pem(),
    )
    .unwrap();
    assert!(SecurityConfig::from_values(&base).is_err());
    let base = pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    );
    fs::write(base["ANTNEST_TLS_CA_FILE"].as_str(), Pki::new().ca.pem()).unwrap();
    assert!(SecurityConfig::from_values(&base).is_err());
}

#[test]
fn receiver_file_is_bounded_regular_and_errors_do_not_expose_authority() {
    let root = tempfile::tempdir().unwrap();
    let base = token_values(&root);
    let path = base["ANTNEST_SERVICE_AUTH_CALLERS_FILE"].as_str();
    for raw in [
        vec![b' '; 8193],
        vec![0xff],
        b"{\"agent-controller\":[]}".to_vec(),
        b"{\"not-a-service\":[]}".to_vec(),
    ] {
        fs::write(path, raw).unwrap();
        let error = SecurityConfig::from_values(&base)
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains(path));
        assert!(!error.contains(support::workload_token()));
    }
    fs::remove_file(path).unwrap();
    assert!(SecurityConfig::from_values(&base).is_err());
    fs::create_dir(path).unwrap();
    assert!(SecurityConfig::from_values(&base).is_err());
}
