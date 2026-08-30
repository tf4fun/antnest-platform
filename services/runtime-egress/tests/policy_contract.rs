use antnest_runtime_egress::policy::{Decision, PolicySpec};

#[test]
fn machine_schema_defines_exactly_the_rust_policy_documents() {
    let schema: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/egress/policy.schema.json"
    )))
    .expect("policy schema");
    let variants = schema["oneOf"].as_array().expect("policy variants");
    let actions = variants
        .iter()
        .map(|variant| {
            assert_eq!(variant["additionalProperties"], false);
            assert_eq!(variant["properties"]["schema_version"]["const"], 1);
            variant["properties"]["action"]["const"]
                .as_str()
                .expect("policy action")
        })
        .collect::<std::collections::BTreeSet<_>>();

    assert_eq!(
        actions,
        std::collections::BTreeSet::from(["allow_all", "deny_all"])
    );
    for action in actions {
        let document = format!(r#"{{"schema_version":1,"action":"{action}"}}"#);
        serde_json::from_str::<PolicySpec>(&document).expect("schema policy accepted by Rust");
    }
}

#[test]
fn policy_schema_has_only_explicit_allow_and_deny() {
    let allow: PolicySpec =
        serde_json::from_str(r#"{"schema_version":1,"action":"allow_all"}"#).expect("allow policy");
    let deny: PolicySpec =
        serde_json::from_str(r#"{"schema_version":1,"action":"deny_all"}"#).expect("deny policy");

    let resolver = "100.64.0.1".parse().unwrap();
    assert_eq!(
        allow
            .compile(resolver)
            .decide("93.184.216.34".parse().unwrap(), 443),
        Decision::Allow
    );
    assert_eq!(
        deny.compile(resolver)
            .decide("93.184.216.34".parse().unwrap(), 443),
        Decision::Deny
    );
}

#[test]
fn compiled_policy_owns_the_non_bypassable_destination_baseline() {
    let resolver = "100.64.0.1".parse().unwrap();
    let policy = PolicySpec::allow_all().compile(resolver);

    assert_eq!(
        policy.decide("10.20.0.8".parse().unwrap(), 443),
        Decision::Deny
    );
    assert_eq!(policy.decide(resolver, 53), Decision::Allow);
    assert_eq!(policy.decide(resolver, 443), Decision::Deny);
}

#[test]
fn policy_rejects_unknown_versions_actions_and_fields() {
    for invalid in [
        r#"{"schema_version":2,"action":"allow_all"}"#,
        r#"{"schema_version":1,"action":"allow_tcp"}"#,
        r#"{"schema_version":1,"action":"deny_all","except":"1.1.1.1"}"#,
    ] {
        assert!(
            serde_json::from_str::<PolicySpec>(invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn absent_assignment_is_fail_closed() {
    assert_eq!(
        PolicySpec::for_assignment(None, "100.64.0.1".parse().unwrap())
            .decide("93.184.216.34".parse().unwrap(), 443),
        Decision::Deny
    );
}
