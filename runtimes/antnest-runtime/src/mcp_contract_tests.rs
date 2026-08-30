use serde::Deserialize;
use serde_json::json;

use crate::config::{
    FilesystemSpecInput, Ipv4EndpointInput, NetworkSpecInput, RuntimeSpecInput, SocketAddressInput,
};
use crate::mcp::{MCP_PATH, RuntimeHttp, RuntimeStatus, STATUS_PATH, route_label};
use crate::spec::RuntimeIdentity;

#[derive(Deserialize)]
struct Contract {
    mcp_protocol_version: String,
    runtime_spec: String,
    transport: Transport,
    status: serde_json::Value,
    readiness: Readiness,
    lifecycle: Lifecycle,
    lifecycle_errors: LifecycleErrors,
    bootstrap_stages: Vec<String>,
    tool_errors: Vec<String>,
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
            .map(|code| code.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(contract.execution.single_flight_enforced_by, "runtime");
    assert_eq!(contract.execution.max_active_calls_per_agent, 1);
    assert_eq!(contract.execution.busy_error, "runtime_busy");
    assert_eq!(contract.execution.subcommands, contract.tools);

    let status = RuntimeStatus::new(RuntimeIdentity::new("agent-1", 2).unwrap());
    assert_eq!(serde_json::to_value(status).unwrap(), contract.status);
    assert_eq!(RuntimeHttp::tool_names(), contract.tools);
}

fn assert_runtime_spec_shape(schema: &serde_json::Value) {
    let input = RuntimeSpecInput {
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
    assert_eq!(object.len(), required.len());
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

#[cfg(target_os = "linux")]
#[tokio::test]
async fn official_mcp_client_observes_status_and_calls_all_runtime_tools() {
    use std::sync::Arc;

    use rmcp::{
        ClientLifecycleMode, ClientServiceExt,
        model::{ClientCapabilities, ClientInfo, Implementation, ProtocolVersion},
        transport::StreamableHttpClientTransport,
    };
    use tokio_util::sync::CancellationToken;

    use crate::roots::NamedRoots;

    let workspace = tempfile::tempdir().expect("workspace");
    let skills = tempfile::tempdir().expect("skills");
    let roots = Arc::new(NamedRoots::open(workspace.path(), skills.path()).expect("roots"));
    let shutdown = CancellationToken::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind Runtime HTTP");
    let address = listener.local_addr().expect("Runtime HTTP address");
    let server = RuntimeHttp::new_in_process(
        RuntimeStatus::new(RuntimeIdentity::new("agent-1", 2).unwrap()),
        roots,
    );
    let running_shutdown = shutdown.clone();
    let running = tokio::spawn(async move { server.serve(listener, running_shutdown).await });

    let status: serde_json::Value = reqwest::get(format!("http://{address}{STATUS_PATH}"))
        .await
        .expect("GET Runtime status")
        .error_for_status()
        .expect("Runtime status success")
        .json()
        .await
        .expect("decode Runtime status");
    assert_eq!(
        status,
        json!({
            "agent_id": "agent-1",
            "generation": 2,
            "status": "ready"
        })
    );

    let mut headers = std::collections::HashMap::new();
    headers.insert(
        axum::http::header::HOST,
        axum::http::HeaderValue::from_static("antnest-runtime:8093"),
    );
    let transport = StreamableHttpClientTransport::from_config(
        rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(
            format!("http://{address}{MCP_PATH}"),
        )
        .custom_headers(headers),
    );
    let client_info = ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("antnest-runtime-test", "0.0.0"),
    )
    .with_protocol_version(ProtocolVersion::V_2026_07_28);
    let client = client_info
        .serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await
        .expect("connect official MCP client");
    assert_eq!(
        client
            .peer_info()
            .expect("server handshake info")
            .protocol_version
            .as_str(),
        shared_contract().mcp_protocol_version
    );

    let listed = client
        .list_tools(Default::default())
        .await
        .expect("list tools");
    assert!(
        listed.tools.iter().all(|tool| tool.output_schema.is_some()),
        "every Runtime tool must advertise its structured output schema"
    );
    let mut names = listed
        .tools
        .iter()
        .map(|tool| tool.name.to_string())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, shared_contract().tools);

    call(
        &client,
        "write",
        json!({
            "path": {"root": "workspace", "path": "notes.txt"},
            "content": "before"
        }),
    )
    .await;
    call(
        &client,
        "edit",
        json!({
            "path": {"root": "workspace", "path": "notes.txt"},
            "old_string": "before",
            "new_string": "after"
        }),
    )
    .await;
    let read = call(
        &client,
        "read",
        json!({
            "path": {"root": "workspace", "path": "notes.txt"},
            "offset": 0,
            "limit": 1024
        }),
    )
    .await;
    assert_eq!(read.structured_content.unwrap()["content"], "after");

    let bash = call(
        &client,
        "bash",
        json!({
            "command": "cat notes.txt",
            "working_dir": {"root": "workspace", "path": "."},
            "env": [],
            "timeout_ms": 1000
        }),
    )
    .await;
    let structured = bash.structured_content.unwrap();
    assert_eq!(structured["exit_code"], 0);
    assert_eq!(structured["stdout"], "after");

    client.cancel().await.expect("stop MCP client");
    shutdown.cancel();
    running
        .await
        .expect("join Runtime HTTP")
        .expect("serve Runtime HTTP");
}

#[cfg(target_os = "linux")]
async fn call(
    client: &rmcp::service::RunningService<rmcp::RoleClient, rmcp::model::ClientInfo>,
    name: &str,
    arguments: serde_json::Value,
) -> rmcp::model::CallToolResult {
    let arguments = arguments.as_object().cloned().expect("tool arguments");
    let result = client
        .call_tool(
            rmcp::model::CallToolRequestParams::new(name.to_owned()).with_arguments(arguments),
        )
        .await
        .expect("call Runtime tool");
    assert_ne!(result.is_error, Some(true), "{name}: {result:?}");
    result
}

fn shared_contract() -> Contract {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/contract.json"
    )))
    .expect("decode shared Runtime contract")
}
