use serde::Deserialize;
use serde_json::json;

use crate::config::{
    FilesystemSpecInput, Ipv4EndpointInput, NetworkSpecInput, RuntimeSpecInput,
    SkillMaintenanceVerifiersInput, SocketAddressInput,
};
use crate::mcp::{
    EXPECTED_EXECUTION_HEADER, MCP_PATH, RuntimeHttp, RuntimeStatus, STATUS_PATH,
    execution_fence_error, reject_reserved_maintenance_tool, route_label,
};
use crate::spec::RuntimeIdentity;

#[derive(Deserialize)]
struct Contract {
    mcp_protocol_version: String,
    runtime_spec: String,
    status_schema: String,
    transport: Transport,
    status: serde_json::Value,
    readiness: Readiness,
    lifecycle: Lifecycle,
    lifecycle_errors: LifecycleErrors,
    bootstrap_stages: Vec<String>,
    tool_errors: Vec<String>,
    tool_result: ToolResult,
    execution: Execution,
    tools: Vec<String>,
    egress_tunnel: EgressTunnel,
    packet_format: String,
    packet_fixtures: String,
}

#[derive(Deserialize)]
struct Readiness {
    scope: String,
    egress_dependency_checked: bool,
    executor_identity_checked: bool,
    workspace_access_checked: bool,
    system_skills_access_checked: bool,
}

#[derive(Deserialize)]
struct Execution {
    single_flight_enforced_by: String,
    max_active_calls_per_agent: u8,
    busy_error: String,
    subcommands: Vec<String>,
}

#[derive(Deserialize)]
struct ToolResult {
    effect_states: Vec<String>,
    unknown_effect_source: String,
    success_effect_state: String,
    error_code_field: String,
}

#[derive(Deserialize)]
struct Lifecycle {
    runtime_exit: String,
    requires_fresh_network_namespace: bool,
    network_bootstrap: String,
    preserve_generation_when_spec_unchanged: bool,
}

#[derive(Deserialize)]
struct LifecycleErrors {
    bootstrap: Vec<String>,
    runtime: Vec<String>,
}

#[derive(Deserialize)]
struct Transport {
    status_path: String,
    mcp_path: String,
    kind: String,
    trusted_internal_hosts: bool,
    expected_execution_header: String,
}

#[derive(Deserialize)]
struct EgressTunnel {
    kind: String,
    payload: String,
    packet_contract: String,
    traced: bool,
    policy_owner: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PacketContract {
    revision: u32,
    transport: String,
    inner_ip_version: u8,
    inner_transport_protocol: String,
    inner_mtu: u16,
    fragmentation: bool,
    one_packet_per_datagram: bool,
    readiness_probe: ReadinessProbe,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessProbe {
    destination_ipv4: String,
    destination_port: u16,
    source_port_min: u16,
    request_flags: Vec<String>,
    request_acknowledgement: u32,
    request_payload_bytes: usize,
    response_flags: Vec<String>,
    local_response_only: bool,
}

#[test]
fn shared_contract_matches_runtime_http_surface() {
    let contract = shared_contract();
    assert_eq!(contract.mcp_protocol_version, "2026-07-28");
    assert_eq!(contract.runtime_spec, "runtime-spec.schema.json");
    let runtime_spec: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/runtime-spec.schema.json"
    )))
    .expect("decode RuntimeSpec schema");
    assert_eq!(runtime_spec["title"], "Antnest RuntimeSpec");
    assert_runtime_spec_shape(&runtime_spec);
    assert_eq!(contract.transport.status_path, STATUS_PATH);
    assert_eq!(contract.transport.mcp_path, MCP_PATH);
    assert_eq!(contract.transport.kind, "streamable-http");
    assert!(contract.transport.trusted_internal_hosts);
    assert_eq!(
        contract.transport.expected_execution_header,
        EXPECTED_EXECUTION_HEADER
    );
    assert_eq!(contract.egress_tunnel.kind, "udp");
    assert_eq!(contract.egress_tunnel.payload, "one-complete-ipv4-packet");
    assert_eq!(
        contract.egress_tunnel.packet_contract,
        "packet-contract.json"
    );
    let packet: PacketContract = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/packet-contract.json"
    )))
    .expect("decode packet contract");
    assert_eq!(packet.revision, crate::packet::PACKET_CONTRACT_REVISION);
    assert_eq!(packet.transport, "raw-ip-over-udp");
    assert_eq!(packet.inner_ip_version, 4);
    assert_eq!(packet.inner_transport_protocol, "tcp");
    assert_eq!(packet.inner_mtu, crate::packet::INNER_MTU);
    assert!(!packet.fragmentation);
    assert!(packet.one_packet_per_datagram);
    assert_eq!(packet.readiness_probe.destination_ipv4, "192.0.2.1");
    assert_eq!(packet.readiness_probe.destination_port, 9);
    assert_eq!(packet.readiness_probe.source_port_min, 49_152);
    assert_eq!(packet.readiness_probe.request_flags, ["syn"]);
    assert_eq!(packet.readiness_probe.request_acknowledgement, 0);
    assert_eq!(packet.readiness_probe.request_payload_bytes, 0);
    assert_eq!(packet.readiness_probe.response_flags, ["rst", "ack"]);
    assert!(packet.readiness_probe.local_response_only);
    assert!(!contract.egress_tunnel.traced);
    assert_eq!(contract.egress_tunnel.policy_owner, "runtime-egress");
    assert_eq!(contract.packet_format, "packet-format.md");
    assert_eq!(contract.packet_fixtures, "packet-fixtures.json");
    assert_eq!(contract.readiness.scope, "runtime-with-egress-path");
    assert!(contract.readiness.egress_dependency_checked);
    assert!(contract.readiness.executor_identity_checked);
    assert!(contract.readiness.workspace_access_checked);
    assert!(contract.readiness.system_skills_access_checked);
    assert_eq!(
        contract.lifecycle.runtime_exit,
        "restart_or_replace_instance"
    );
    assert!(!contract.lifecycle.requires_fresh_network_namespace);
    assert_eq!(
        contract.lifecycle.network_bootstrap,
        "reconcile_owned_artifacts"
    );
    assert!(contract.lifecycle.preserve_generation_when_spec_unchanged);
    assert_eq!(
        contract.lifecycle_errors.bootstrap,
        crate::lifecycle_error::BootstrapErrorCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        contract.lifecycle_errors.runtime,
        crate::lifecycle_error::RuntimeErrorCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        contract.bootstrap_stages,
        crate::lifecycle_error::BootstrapStage::ALL
            .iter()
            .map(|stage| stage.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        contract.tool_errors,
        crate::tool_error::ToolErrorCode::ALL
            .iter()
            .filter(|code| code.is_model_facing())
            .map(|code| code.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        contract.tool_result.effect_states,
        ["none", "settled", "unknown"]
    );
    assert_eq!(contract.tool_result.unknown_effect_source, "runtime_mcp");
    assert_eq!(contract.tool_result.success_effect_state, "settled");
    assert_eq!(contract.tool_result.error_code_field, "error_code");
    assert_eq!(contract.execution.single_flight_enforced_by, "runtime");
    assert_eq!(contract.execution.max_active_calls_per_agent, 1);
    assert_eq!(contract.execution.busy_error, "runtime_busy");
    let mut commands = contract.tools.clone();
    commands.push("info".into());
    commands.sort();
    assert_eq!(contract.execution.subcommands, commands);

    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 2).unwrap(),
        "execution-1",
    );
    assert_eq!(contract.status_schema, "runtime-status.schema.json");
    assert_eq!(contract.status["test_features"], json!([]));
    let mut expected_status = contract.status;
    if cfg!(feature = "skill-maintenance-e2e-gate") {
        expected_status["test_features"] = json!(["skill-maintenance-e2e-gate"]);
    }
    assert_eq!(serde_json::to_value(status).unwrap(), expected_status);
    assert_eq!(RuntimeHttp::tool_names(), contract.tools);
}

fn assert_runtime_spec_shape(schema: &serde_json::Value) {
    let input = RuntimeSpecInput {
        mcp_servers: Vec::new(),
        skill_maintenance_verifiers: SkillMaintenanceVerifiersInput::default(),
        agent_id: "agent-1".into(),
        generation: 2,
        listen: SocketAddressInput {
            host: "0.0.0.0".into(),
            port: 8093,
        },
        network: NetworkSpecInput {
            packet_contract_revision: crate::packet::PACKET_CONTRACT_REVISION,
            egress_endpoint: Ipv4EndpointInput {
                ipv4: "192.0.2.10".into(),
                port: 8092,
            },
            tunnel_ipv4: "100.96.0.2".into(),
            resolver_ipv4: "100.64.0.1".into(),
        },
        filesystem: FilesystemSpecInput {
            workspace: "/workspace".into(),
            system_skills: "/skills".into(),
        },
    };
    let required = schema["required"].as_array().expect("RuntimeSpec required");
    let encoded = serde_json::to_value(input).expect("encode RuntimeSpec input");
    let object = encoded.as_object().expect("RuntimeSpec object");
    assert_object_shape(object, &schema["properties"], required);
    assert_object_shape(
        object["listen"].as_object().expect("listen input"),
        &schema["$defs"]["socketAddress"]["properties"],
        schema["$defs"]["socketAddress"]["required"]
            .as_array()
            .expect("listen required"),
    );
    assert_object_shape(
        object["network"].as_object().expect("network input"),
        &schema["properties"]["network"]["properties"],
        schema["properties"]["network"]["required"]
            .as_array()
            .expect("network required"),
    );
    assert_object_shape(
        object["filesystem"].as_object().expect("filesystem input"),
        &schema["properties"]["filesystem"]["properties"],
        schema["properties"]["filesystem"]["required"]
            .as_array()
            .expect("filesystem required"),
    );
    let decoded: RuntimeSpecInput =
        serde_json::from_value(encoded).expect("decode RuntimeSpec input");
    decoded
        .try_into_runtime_spec()
        .expect("adapt RuntimeSpec input");

    let invalid = [
        RuntimeSpecInput {
            agent_id: " ".into(),
            ..valid_input()
        },
        RuntimeSpecInput {
            listen: SocketAddressInput {
                host: "0.0.0.0".into(),
                port: 0,
            },
            ..valid_input()
        },
        RuntimeSpecInput {
            filesystem: FilesystemSpecInput {
                workspace: "workspace".into(),
                system_skills: "/skills".into(),
            },
            ..valid_input()
        },
        RuntimeSpecInput {
            network: NetworkSpecInput {
                packet_contract_revision: crate::packet::PACKET_CONTRACT_REVISION,
                egress_endpoint: Ipv4EndpointInput {
                    ipv4: "192.0.2.10".into(),
                    port: 8092,
                },
                tunnel_ipv4: "100.96.0.2".into(),
                resolver_ipv4: "100.96.0.2".into(),
            },
            ..valid_input()
        },
        RuntimeSpecInput {
            network: NetworkSpecInput {
                packet_contract_revision: crate::packet::PACKET_CONTRACT_REVISION + 1,
                ..valid_input().network
            },
            ..valid_input()
        },
    ];
    assert!(
        invalid
            .into_iter()
            .all(|value| value.try_into_runtime_spec().is_err())
    );
}

fn valid_input() -> RuntimeSpecInput {
    RuntimeSpecInput {
        mcp_servers: Vec::new(),
        skill_maintenance_verifiers: SkillMaintenanceVerifiersInput::default(),
        agent_id: "agent-1".into(),
        generation: 2,
        listen: SocketAddressInput {
            host: "0.0.0.0".into(),
            port: 8093,
        },
        network: NetworkSpecInput {
            packet_contract_revision: crate::packet::PACKET_CONTRACT_REVISION,
            egress_endpoint: Ipv4EndpointInput {
                ipv4: "192.0.2.10".into(),
                port: 8092,
            },
            tunnel_ipv4: "100.96.0.2".into(),
            resolver_ipv4: "100.64.0.1".into(),
        },
        filesystem: FilesystemSpecInput {
            workspace: "/workspace".into(),
            system_skills: "/skills".into(),
        },
    }
}

fn assert_object_shape(
    object: &serde_json::Map<String, serde_json::Value>,
    properties: &serde_json::Value,
    required: &[serde_json::Value],
) {
    let properties = properties.as_object().expect("schema properties");
    assert_eq!(object.len(), properties.len());
    assert!(object.len() >= required.len());
    assert!(object.keys().all(|name| properties.contains_key(name)));
    assert!(
        required
            .iter()
            .all(|name| object.contains_key(name.as_str().expect("required property name")))
    );
}

#[test]
fn telemetry_uses_only_bounded_route_labels() {
    assert_eq!(route_label(STATUS_PATH), STATUS_PATH);
    assert_eq!(route_label(MCP_PATH), MCP_PATH);
    assert_eq!(route_label("/mcp/session"), MCP_PATH);
    assert_eq!(route_label("/secret-in-path"), "unmatched");
}

#[test]
fn mcp_execution_fence_fails_closed() {
    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 2).unwrap(),
        "execution-1",
    );
    let mut headers = axum::http::HeaderMap::new();
    assert_eq!(execution_fence_error(&headers, &status), Some("missing"));
    headers.insert(
        axum::http::HeaderName::from_static("x-antnest-expected-execution-id"),
        axum::http::HeaderValue::from_static("execution-old"),
    );
    assert_eq!(execution_fence_error(&headers, &status), Some("mismatch"));
    headers.insert(
        axum::http::HeaderName::from_static("x-antnest-expected-execution-id"),
        axum::http::HeaderValue::from_static("execution-1"),
    );
    assert_eq!(execution_fence_error(&headers, &status), None);
}

#[test]
fn maintenance_names_cannot_enter_the_model_tool_path() {
    for name in [
        "antnest_skill_maintenance_prepare",
        "antnest_skill_maintenance_commit",
        "antnest_skill_maintenance_future_action",
        "antnest_skill_temporary_install",
        "antnest_skill_temporary_release",
        "antnest_skill_temporary_future_action",
    ] {
        assert!(reject_reserved_maintenance_tool(name).is_err(), "{name}");
    }
    for name in ["bash", "read", "mcp__notes__search"] {
        assert!(reject_reserved_maintenance_tool(name).is_ok(), "{name}");
    }
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/integration/antnest-runtime/mcp_wire.rs"
));

fn shared_contract() -> Contract {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/contract.json"
    )))
    .expect("decode shared Runtime contract")
}
