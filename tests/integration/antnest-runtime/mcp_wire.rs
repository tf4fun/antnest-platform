#[cfg(target_os = "linux")]
#[tokio::test]
async fn official_mcp_client_observes_status_and_calls_all_runtime_tools() {
    use std::sync::Arc;

    use rmcp::{
        ClientLifecycleMode, ClientServiceExt,
        model::{ClientCapabilities, ClientConfig, Implementation, ProtocolVersion},
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
    let client_info = ClientConfig::new(
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
                "path": "AGENTS.md", "content": content
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
            "path": "notes.txt",
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
            "path": "notes.txt",
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
    let read = call(&client, "read", json!({"path": "notes.txt"})).await;
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
    assert_eq!(structured["next_offset"], serde_json::Value::Null);
    assert!(structured.get("file").is_none());

    call(
        &client,
        "write",
        json!({"path": "nested/中文.md", "content": "标题\n第一步\n第二步\n"}),
    )
    .await;
    let page = call(
        &client,
        "read",
        json!({"path": "/workspace/nested/中文.md", "limit": 2}),
    )
    .await
    .structured_content
    .unwrap();
    assert_eq!(page["content"], "标题\n第一步\n");
    assert_eq!(page["truncated"], true);
    assert_eq!(page["next_offset"], 3);
    let page = call(
        &client,
        "read",
        json!({"path": "~/nested/中文.md", "offset": page["next_offset"]}),
    )
    .await
    .structured_content
    .unwrap();
    assert_eq!(page["content"], "第二步\n");
    assert_eq!(page["truncated"], false);
    assert_eq!(page["next_offset"], serde_json::Value::Null);
    assert_eq!(structured["effect_state"], "settled");
    assert!(structured["effect_source"].is_null());

    let bash = call(
        &client,
        "bash",
        json!({
            "command": "cat notes.txt"
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

#[tokio::test]
async fn private_skill_maintenance_http_stays_closed_without_trusted_credentials() {
    use tower::ServiceExt as _;

    use crate::mcp::skill_maintenance_router;
    use crate::spec::SkillMaintenanceVerifier;

    for (keys, expected) in [
        (vec![], reqwest::StatusCode::FORBIDDEN),
        (
            vec![SkillMaintenanceVerifier::new("key-1".into(), [0; 32])],
            reqwest::StatusCode::UNAUTHORIZED,
        ),
    ] {
        let status = RuntimeStatus::with_execution_id(
            RuntimeIdentity::new("agent-1", 2).unwrap(),
            "execution-1",
        );
        let router = skill_maintenance_router(status, keys);
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/internal/skill-maintenance/commit")
            .header("X-Antnest-Expected-Execution-ID", "execution-1")
            .body(axum::body::Body::from("{}"))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status().as_u16(), expected.as_u16());
    }
}

#[tokio::test]
async fn private_skill_maintenance_http_rejects_signed_but_invalid_control_body() {
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt as _;

    use crate::mcp::skill_maintenance_router;
    use crate::skill_maintenance_auth_tests::{fixture, signed};

    let (pair, _, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 2).unwrap(),
        "execution-1",
    );
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let body = b"{}";
    let token = signed(&pair, body, |payload| {
        payload["issued_at"] = json!(now);
        payload["expires_at"] = json!(now + 60);
    });
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/internal/skill-maintenance/commit")
        .header("X-Antnest-Expected-Execution-ID", "execution-1")
        .header(axum::http::header::AUTHORIZATION, token)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.as_slice()))
        .unwrap();
    let response = skill_maintenance_router(status, keys)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);

    let (pair, _, keys) = fixture();
    let repeated = axum::http::Request::builder()
        .method("POST")
        .uri("/internal/skill-maintenance/commit")
        .header("X-Antnest-Expected-Execution-ID", "execution-1")
        .header(
            axum::http::header::AUTHORIZATION,
            signed(&pair, body, |payload| {
                payload["issued_at"] = json!(now);
                payload["expires_at"] = json!(now + 60);
            }),
        )
        .header(axum::http::header::AUTHORIZATION, "Bearer duplicate")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body.as_slice()))
        .unwrap();
    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 2).unwrap(),
        "execution-1",
    );
    let response = skill_maintenance_router(status, keys)
        .oneshot(repeated)
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn private_skill_prepare_validates_the_signed_multipart_package_before_admission() {
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt as _;

    use crate::mcp::skill_maintenance_router;
    use crate::skill_maintenance_auth_tests::{fixture, signed};
    use crate::skill_maintenance_request_tests::{prepared_body, prepared_zip};

    let (pair, _, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 1).unwrap(),
        "execution-1",
    );
    let artifact = prepared_zip();
    let package = crate::skill_package_zip::validate_skill_zip(&artifact).unwrap();
    let metadata = json!({
        "action":"prepare", "request_id":"request-1", "job_id":"job-1", "generation":1,
        "candidate_id":"candidate-1", "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null, "target_digest":package.content_digest,
        "artifact_digest":package.artifact_digest, "package_rules_version":1
    });
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let send = |body: Vec<u8>| {
        let token = signed(&pair, &body, |payload| {
            payload["action"] = json!("prepare");
            payload["issued_at"] = json!(now);
            payload["expires_at"] = json!(now + 60);
        });
        axum::http::Request::builder()
            .method("POST")
            .uri("/internal/skill-maintenance/prepare")
            .header("X-Antnest-Expected-Execution-ID", "execution-1")
            .header(axum::http::header::AUTHORIZATION, token)
            .header(
                axum::http::header::CONTENT_TYPE,
                "multipart/form-data; boundary=skill-boundary",
            )
            .body(axum::body::Body::from(body))
            .unwrap()
    };
    let valid = prepared_body(&metadata, &artifact);
    let response = skill_maintenance_router(status.clone(), keys.clone())
        .oneshot(send(valid))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    let invalid = prepared_body(&metadata, b"not a ZIP");
    let response = skill_maintenance_router(status, keys)
        .oneshot(send(invalid))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
}

#[cfg(target_os = "linux")]
async fn call(
    client: &rmcp::service::RunningService<rmcp::RoleClient, rmcp::model::ClientConfig>,
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
