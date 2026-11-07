use std::{
    net::{Ipv4Addr, SocketAddrV4},
    path::PathBuf,
};

use antnest_runtime_tunnel::KeyId;
use serde_json::Value;

use super::{
    AssignmentResponse, NetworkResponse, PolicyRevisionDetailResponse, PolicyRevisionResponse,
};
use crate::{
    application::RuntimeNetworkAttachment,
    domain::{AgentId, AttachmentState, NetworkState, PolicyId},
    policy::PolicySpec,
    repository::policy_revision,
};

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/egress/examples")
        .join(name)
}

fn assert_golden(name: &str, actual: &Value, failures: &mut Vec<String>) {
    let path = golden_path(name);
    if std::env::var("UPDATE_GOLDEN").as_deref() == Ok("1") {
        let pretty = serde_json::to_string_pretty(actual).expect("serialize golden") + "\n";
        std::fs::create_dir_all(path.parent().expect("examples parent"))
            .expect("create examples directory");
        std::fs::write(&path, pretty).expect("write golden document");
    }
    match std::fs::read_to_string(&path) {
        Err(err) => failures.push(format!("{name}: missing golden file: {err}")),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Err(err) => failures.push(format!("{name}: golden is not JSON: {err}")),
            Ok(expected) => {
                if expected != *actual {
                    failures.push(format!(
                        "{name}: golden mismatch\nexpected: {text}\nactual: {}",
                        serde_json::to_string_pretty(actual).expect("serialize actual")
                    ));
                }
            }
        },
    }
}

#[test]
fn control_producer_goldens() {
    let mut failures = Vec::new();

    let agent = AgentId::parse("agent-1").expect("agent id");
    let attachment = RuntimeNetworkAttachment {
        tunnel_key_id: None,
        agent_id: agent.clone(),
        tunnel_ipv4: Ipv4Addr::new(100, 64, 0, 2),
        resolver_ipv4: Ipv4Addr::new(100, 64, 0, 1),
        egress_endpoint: SocketAddrV4::new(Ipv4Addr::new(10, 20, 0, 8), 8092),
        state: NetworkState::Active,
        network_resource_version: 1,
        attachment_state: AttachmentState::Closed,
        attachment_resource_version: 1,
        runtime_endpoint: None,
    };
    assert_golden(
        "network.closed.json",
        &serde_json::to_value(NetworkResponse::from(attachment.clone()))
            .expect("network response serializes"),
        &mut failures,
    );

    let mut open = attachment;
    open.attachment_state = AttachmentState::Open;
    open.attachment_resource_version = 2;
    open.runtime_endpoint = Some(Ipv4Addr::new(10, 243, 1, 20));
    open.tunnel_key_id =
        Some(KeyId::parse("rtk_0123456789abcdef0123456789abcdef").expect("tunnel key id"));
    assert_golden(
        "network.open.json",
        &serde_json::to_value(NetworkResponse::from(open)).expect("network response serializes"),
        &mut failures,
    );

    let spec_v1: PolicySpec = serde_json::from_str(r#"{"schema_version":1,"action":"allow_all"}"#)
        .expect("v1 spec parses");
    let spec_v2: PolicySpec = serde_json::from_str(
        r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"],"ports":[443]}]}"#,
    )
    .expect("v2 spec parses");

    let revision_v1 = policy_revision(
        PolicyId::parse("builtin/allow-all").expect("policy id"),
        1,
        spec_v1,
    );
    assert_golden(
        "policy.v1.json",
        &serde_json::to_value(PolicyRevisionDetailResponse::from(revision_v1.clone()))
            .expect("policy detail serializes"),
        &mut failures,
    );
    assert_golden(
        "policy-metadata.v1.json",
        &serde_json::to_value(PolicyRevisionResponse::from(revision_v1))
            .expect("policy metadata serializes"),
        &mut failures,
    );

    let revision_v2 = policy_revision(
        PolicyId::parse("custom/policy-v2").expect("policy id"),
        1,
        spec_v2,
    );
    assert_golden(
        "policy.v2.json",
        &serde_json::to_value(PolicyRevisionDetailResponse::from(revision_v2.clone()))
            .expect("policy detail serializes"),
        &mut failures,
    );
    assert_golden(
        "policy-metadata.v2.json",
        &serde_json::to_value(PolicyRevisionResponse::from(revision_v2))
            .expect("policy metadata serializes"),
        &mut failures,
    );

    let assignment = crate::domain::PolicyAssignment {
        agent_id: agent,
        policy_id: PolicyId::parse("builtin/allow-all").expect("policy id"),
        revision: 1,
        resource_version: 1,
    };
    assert_golden(
        "assignment.current.json",
        &serde_json::to_value(AssignmentResponse::from(assignment)).expect("assignment serializes"),
        &mut failures,
    );

    assert!(
        failures.is_empty(),
        "producer golden failures:\n{}",
        failures.join("\n")
    );
}
