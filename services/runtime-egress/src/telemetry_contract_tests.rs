use opentelemetry::{KeyValue, Value};

use super::{
    alias_attributes_with_legacy, capture_rpc_json, legacy_attributes_enabled, metric_attributes,
};

fn pairs(entries: &[(&str, &str)]) -> Vec<KeyValue> {
    entries
        .iter()
        .map(|(key, value)| KeyValue::new(key.to_string(), value.to_string()))
        .collect()
}

fn value_of(attributes: &[KeyValue], key: &str) -> Option<String> {
    attributes
        .iter()
        .find(|attribute| attribute.key.as_str() == key)
        .map(|attribute| attribute.value.to_string())
}

#[test]
fn canonical_attribute_wins_regardless_of_insertion_order() {
    for input in [
        pairs(&[("antnest.agent.id", "a"), ("antnest.agent_id", "b")]),
        pairs(&[("antnest.agent_id", "b"), ("antnest.agent.id", "a")]),
    ] {
        assert_eq!(
            value_of(
                &alias_attributes_with_legacy(input, true),
                "antnest.agent.id"
            ),
            Some("a".to_string())
        );
    }
}

#[test]
fn default_mode_dual_emits_canonical_and_legacy_with_identical_values() {
    let normalized = alias_attributes_with_legacy(pairs(&[("antnest.agent.id", "a")]), true);
    for key in ["antnest.agent.id", "antnest.agent_id"] {
        assert_eq!(value_of(&normalized, key), Some("a".to_string()), "{key}");
    }
}

#[test]
fn disabled_mode_emits_canonical_keys_only() {
    let normalized = alias_attributes_with_legacy(
        pairs(&[("antnest.agent.id", "a"), ("antnest.agent_id", "a")]),
        false,
    );
    assert_eq!(value_of(&normalized, "antnest.agent_id"), None);
    assert_eq!(
        value_of(&normalized, "antnest.agent.id"),
        Some("a".to_string())
    );
}

#[test]
fn external_attributes_pass_through_unchanged() {
    let normalized = alias_attributes_with_legacy(
        pairs(&[("http.route", "/x"), ("terminal_class", "failed")]),
        true,
    );
    assert_eq!(
        value_of(&normalized, "terminal_class"),
        Some("failed".to_string())
    );
}

#[test]
fn typed_attribute_values_are_preserved() {
    let normalized = alias_attributes_with_legacy(
        vec![
            KeyValue::new("antnest.enabled", true),
            KeyValue::new("antnest.count", 3i64),
        ],
        true,
    );
    for attribute in &normalized {
        match attribute.key.as_str() {
            "antnest.enabled" => assert!(matches!(attribute.value, Value::Bool(true))),
            "antnest.count" => assert!(matches!(attribute.value, Value::I64(3))),
            key => panic!("unexpected attribute {key}"),
        }
    }
    assert_eq!(normalized.len(), 2);
}

#[test]
fn metric_attributes_strips_unbounded_ids_and_payloads() {
    let filtered = metric_attributes(pairs(&[
        ("antnest.agent.id", "a"),
        ("antnest.agent_id", "a"),
        ("antnest.run.id", "r"),
        ("antnest.session.id", "s"),
        ("antnest.request.id", "q"),
        ("antnest.organization.id", "o"),
        ("antnest.runtime.execution.id", "e"),
        ("antnest.payload.json", "{}"),
        ("antnest.outcome", "success"),
    ]));
    for key in [
        "antnest.agent.id",
        "antnest.agent_id",
        "antnest.run.id",
        "antnest.session.id",
        "antnest.request.id",
        "antnest.organization.id",
        "antnest.runtime.execution.id",
        "antnest.payload.json",
    ] {
        assert_eq!(value_of(&filtered, key), None, "{key} must be filtered");
    }
    assert_eq!(
        value_of(&filtered, "antnest.outcome"),
        Some("success".to_string())
    );
}

#[test]
fn legacy_switch_parses_trimmed_lowercase_values() {
    assert!(legacy_attributes_enabled(None));
    assert!(!legacy_attributes_enabled(Some(" FALSE ")));
    assert!(legacy_attributes_enabled(Some("true")));
    assert!(legacy_attributes_enabled(Some("1")));
}

const SHARED_SECRET_KEYS: &[&str] = &[
    "password",
    "password_hash",
    "authorization",
    "proxy_authorization",
    "cookie",
    "set_cookie",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "secret",
    "client_secret",
    "api_key",
    "private_key",
    "credential",
    "credentials",
    "workload_credential",
    "caller_context",
    "cct",
    "connection_descriptor",
    "generation_key",
    "master_key",
    "encryption_key",
];

#[test]
fn capture_rpc_json_redacts_nested_secrets_and_preserves_public_values() {
    let payload = serde_json::json!({
        "public": "x".repeat(24 * 1024),
        "large": 9007199254740993u64,
        "nested": {
            "password": "PRIVATE-CANARY",
            "Access-Token": "PRIVATE-CANARY",
            "CLIENT_SECRET": "PRIVATE-CANARY",
        },
        "rows": [{"client_secret": "PRIVATE-CANARY"}, {"public_row": 7}],
    });
    let captured: serde_json::Value =
        serde_json::from_str(&capture_rpc_json(&payload).expect("serialize"))
            .expect("captured JSON");
    assert_eq!(captured["public"], serde_json::json!("x".repeat(24 * 1024)));
    assert_eq!(captured["large"], serde_json::json!(9007199254740993u64));
    for key in ["password", "Access-Token", "CLIENT_SECRET"] {
        assert_eq!(
            captured["nested"][key],
            serde_json::json!("[REDACTED]"),
            "{key}"
        );
    }
    for &key in SHARED_SECRET_KEYS {
        let nested = serde_json::json!({key: "PRIVATE-CANARY"});
        let redacted: serde_json::Value =
            serde_json::from_str(&capture_rpc_json(&nested).expect("serialize"))
                .expect("captured JSON");
        assert_eq!(redacted[key], serde_json::json!("[REDACTED]"), "{key}");
    }
    assert_eq!(
        captured["rows"][0]["client_secret"],
        serde_json::json!("[REDACTED]")
    );
    assert_eq!(captured["rows"][1]["public_row"], serde_json::json!(7));
    let rendered = captured.to_string();
    assert!(!rendered.contains("PRIVATE-CANARY"));
    assert_eq!(
        payload["nested"]["password"],
        serde_json::json!("PRIVATE-CANARY")
    );
}

#[test]
fn capture_rpc_json_surfaces_serialize_errors_without_panic() {
    struct Fails;
    impl serde::Serialize for Fails {
        fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("intentional failure"))
        }
    }
    assert!(capture_rpc_json(&Fails).is_err());
}
