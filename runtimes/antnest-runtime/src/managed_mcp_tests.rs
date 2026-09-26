use serde_json::json;

use crate::managed_mcp::catalog::exposed_name;
use crate::managed_mcp::spec::{ServerInput, validate_servers};

#[test]
fn managed_config_is_bounded_and_redacts_command_and_credentials() {
    let input: ServerInput = serde_json::from_value(json!({
        "id": "docs", "command": "secret-command", "args": ["secret-arg"],
        "env": {"TOKEN": "secret-value"}
    }))
    .unwrap();
    let description = format!("{input:?}");
    assert!(!description.contains("secret"));
    assert_eq!(validate_servers(vec![input.clone()]).unwrap().len(), 1);
    assert!(validate_servers(vec![input.clone(), input]).is_err());
    for value in [
        json!({"id": "../docs", "command": "node"}),
        json!({"id": "docs", "command": ""}),
        json!({"id": "docs", "command": "node", "env": {"HOME": "/root"}}),
        json!({"id": "docs", "command": "node", "env": {"ANTNEST_RUNTIME_SPEC": "secret"}}),
        json!({"id": "docs", "command": "node", "args": ["\u{0}"]}),
    ] {
        assert!(validate_servers(vec![serde_json::from_value(value).unwrap()]).is_err());
    }
    assert!(
        serde_json::from_value::<ServerInput>(json!({
            "id": "docs", "command": "node", "url": "http://child"
        }))
        .is_err()
    );
}

#[test]
fn managed_tool_names_are_stable_distinct_and_model_compatible() {
    assert_eq!(exposed_name("docs", "search").unwrap(), "mcp__docs__search");
    assert_ne!(
        exposed_name("a", "read").unwrap(),
        exposed_name("b", "read").unwrap()
    );
    assert_ne!(exposed_name("a", "read").unwrap(), "read");
    let long = "a".repeat(128);
    let name = exposed_name("docs", &long).unwrap();
    assert!(name.len() <= 64);
    // Persisted tool names must stay byte-for-byte stable across hash SDK upgrades.
    assert_eq!(
        name,
        "mcp__docs__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_7c13f0dccd7d06a0"
    );
    assert_eq!(name, exposed_name("docs", &long).unwrap());
    assert_ne!(
        name,
        exposed_name("docs", &format!("{}b", "a".repeat(127))).unwrap()
    );
    assert!(exposed_name("docs", "invalid/name").is_err());
    assert_ne!(
        exposed_name("docs", "a.b").unwrap(),
        exposed_name("docs", "a_b").unwrap()
    );
    assert!(!exposed_name("docs", "a.b").unwrap().contains('.'));
    assert_eq!(
        exposed_name("docs", "a.b").unwrap(),
        "mcp__docs__a_b_b0addbda3eec8b12"
    );
}

#[test]
fn managed_config_total_fits_the_bootstrap_environment() {
    let servers: Vec<ServerInput> = (0..8)
        .map(|index| {
            serde_json::from_value(json!({
                "id": format!("server-{index}"), "command": "node",
                "env": {"TOKEN": "a".repeat(8192)}
            }))
            .unwrap()
        })
        .collect();
    assert!(validate_servers(vec![servers[0].clone()]).is_ok());
    assert!(validate_servers(servers).is_err());
}

mod bridge {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/integration/antnest-runtime/managed_bridge.rs"
    ));
}
