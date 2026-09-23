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
    let runtime_status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 2).unwrap(),
        "execution-1",
    );
    let server = RuntimeHttp::new_in_process(runtime_status, roots);
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
            "execution_id": "execution-1",
            "status": "ready"
        })
    );

    let mut headers = std::collections::HashMap::new();
    headers.insert(
        axum::http::header::HOST,
        axum::http::HeaderValue::from_static("antnest-runtime:8093"),
    );
    headers.insert(
        axum::http::HeaderName::from_static("x-antnest-expected-execution-id"),
        axum::http::HeaderValue::from_static("execution-1"),
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

    let resources = client
        .list_resources(None)
        .await
        .expect("list Runtime resources");
    assert_eq!(resources.resources.len(), 1);
    assert_eq!(
        resources.resources[0].uri,
        crate::information::INFORMATION_URI
    );
    assert_eq!(
        resources.resources[0].mime_type.as_deref(),
        Some("application/json")
    );
    for content in ["First instructions", "Updated instructions"] {
        call(
            &client,
            "write",
            json!({
                "path": {"root": "workspace", "path": "AGENTS.md"}, "content": content
            }),
        )
        .await;
        let information = client
            .read_resource(rmcp::model::ReadResourceRequestParams::new(
                crate::information::INFORMATION_URI,
            ))
            .await
            .expect("read fresh Runtime information");
        assert_eq!(information.ttl_ms, Some(0));
        assert_eq!(
            information.cache_scope,
            Some(rmcp::model::CacheScope::Private)
        );
        assert_eq!(information.contents.len(), 1);
        let rmcp::model::ResourceContents::TextResourceContents { text, .. } =
            &information.contents[0]
        else {
            panic!("information must be JSON text");
        };
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(value["execution_id"], "execution-1");
        assert_eq!(value["instructions"]["content"], content);
        assert_eq!(
            value["environment"]["workspace"],
            workspace.path().to_str().unwrap()
        );
    }
    let error = client
        .read_resource(rmcp::model::ReadResourceRequestParams::new(
            "file:///root/secret",
        ))
        .await
        .expect_err("arbitrary resource paths must be rejected");
    assert!(
        matches!(&error, rmcp::ServiceError::McpError(data) if data.code.0 == -32602),
        "unexpected resource error: {error:?}"
    );

    let written = call(
        &client,
        "write",
        json!({
            "path": {"root": "workspace", "path": "notes.txt"},
            "content": "before"
        }),
    )
    .await;
    let metadata = serde_json::to_value(&written.meta).unwrap();
    assert_eq!(
        metadata["io.antnest.runtime/file"]["diff"],
        json!({"oldText": null, "newText": "before"})
    );
    assert_eq!(
        written.structured_content.unwrap(),
        json!({"bytes_written": 6, "effect_state": "settled", "effect_source": null})
    );
    let edited = call(
        &client,
        "edit",
        json!({
            "path": {"root": "workspace", "path": "notes.txt"},
            "old_string": "before",
            "new_string": "after"
        }),
    )
    .await;
    let metadata = serde_json::to_value(&edited.meta).unwrap();
    assert_eq!(
        metadata["io.antnest.runtime/file"]["diff"],
        json!({"oldText": "before", "newText": "after"})
    );
    assert_eq!(
        edited.structured_content.unwrap(),
        json!({"bytes_written": 5, "effect_state": "settled", "effect_source": null})
    );
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
    let metadata = serde_json::to_value(&read.meta).unwrap();
    assert!(
        metadata["io.antnest.runtime/file"]["path"]
            .as_str()
            .unwrap()
            .ends_with("/notes.txt")
    );
    assert!(metadata["io.antnest.runtime/file"]["diff"].is_null());
    let structured = read.structured_content.unwrap();
    assert_eq!(structured["content"], "after");
    assert!(structured.get("file").is_none());
    assert_eq!(structured["effect_state"], "settled");
    assert!(structured["effect_source"].is_null());

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
    assert_eq!(structured["effect_state"], "settled");
    assert!(structured["effect_source"].is_null());

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
