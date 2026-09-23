use crate::managed_mcp::catalog::Catalog;
use rmcp::{RoleServer, ServerHandler, ServiceExt as _, model::*, service::RequestContext};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Fixture {
    calls: Arc<AtomicUsize>,
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult::with_all_items(vec![Tool::new(
            "read",
            "fixture read",
            Arc::new(
                json!({"type":"object","properties":{"value":{"type":"string","x-mcp-header":"Value"}}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )]))
    }

    async fn call_tool(
        &self,
        input: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        assert_eq!(input.name, "read");
        self.calls.fetch_add(1, Ordering::SeqCst);
        let value = input
            .arguments
            .unwrap_or_default()
            .get("value")
            .cloned()
            .unwrap_or_default();
        if value == "wait" {
            context.ct.cancelled().await;
        }
        if value == "fail" {
            return Ok(CallToolResult::error(vec![ContentBlock::text("fixture failed")]).into());
        }
        Ok(CallToolResult::structured(json!({"value":value})).into())
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn managed_schema_drives_http_parameter_header_validation() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (client_io, server_io) = tokio::io::duplex(65536);
    let fixture = Fixture {
        calls: calls.clone(),
    };
    let child = tokio::spawn(async move { fixture.serve(server_io).await.unwrap() });
    let mut client = ().serve(client_io).await.unwrap();
    let mut child = child.await.unwrap();
    let mut catalog = Catalog::default();
    catalog
        .add_server("fixture", client.peer().clone(), Default::default())
        .await
        .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let roots = Arc::new(crate::roots::NamedRoots::open(workspace.path(), skills.path()).unwrap());
    let status =
        crate::mcp::RuntimeStatus::new(crate::spec::RuntimeIdentity::new("agent-1", 1).unwrap());
    let execution = serde_json::to_value(&status).unwrap()["execution_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let http = crate::mcp::RuntimeHttp::new_in_process(status, roots).with_managed(catalog);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let task = tokio::spawn(http.serve(listener, stop.clone()));
    let response = reqwest::Client::new().post(format!("http://{address}/mcp"))
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2026-07-28")
        .header("mcp-method", "tools/call")
        .header("mcp-name", "mcp__fixture__read")
        .header("mcp-param-value", "conflicting")
        .header(crate::mcp::EXPECTED_EXECUTION_HEADER, execution)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
            "name":"mcp__fixture__read","arguments":{"value":"body"},
            "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}
        }})).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    stop.cancel();
    task.await.unwrap().unwrap();
    client.close().await.unwrap();
    child.close().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}");
    let error: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(error["error"]["code"], -32020);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn discovery_dispatch_and_cancellation_preserve_the_managed_service() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut servers = Vec::new();
    let mut clients = Vec::new();
    let mut catalog = Catalog::default();
    for id in ["a", "b"] {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let fixture = Fixture {
            calls: calls.clone(),
        };
        let server = tokio::spawn(async move { fixture.serve(server_io).await.unwrap() });
        let client = ().serve(client_io).await.unwrap();
        catalog
            .add_server(id, client.peer().clone(), Default::default())
            .await
            .unwrap();
        servers.push(server.await.unwrap());
        clients.push(client);
    }
    assert_eq!(
        catalog
            .tools()
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        ["mcp__a__read", "mcp__b__read"]
    );
    assert_eq!(
        catalog.tools()[0].description.as_deref(),
        Some("fixture read")
    );
    assert_eq!(
        catalog.tools()[0].input_schema["properties"]["value"]["type"],
        "string"
    );
    let result = catalog
        .call(
            "mcp__b__read",
            Some(json!({"value":"kept"}).as_object().unwrap().clone()),
            CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(result.structured_content.unwrap()["value"], "kept");
    let failure = catalog
        .call(
            "mcp__a__read",
            Some(json!({"value":"fail"}).as_object().unwrap().clone()),
            CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(failure.is_error, Some(true));
    let cancel = CancellationToken::new();
    let canceled = catalog.call(
        "mcp__a__read",
        Some(json!({"value":"wait"}).as_object().unwrap().clone()),
        cancel.clone(),
        Duration::from_secs(2),
    );
    let (_, result) = tokio::join!(
        async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        },
        canceled
    );
    assert_eq!(
        result.unwrap_err().effect_state,
        crate::tool_error::ToolEffectState::Unknown
    );
    catalog
        .call(
            "mcp__a__read",
            None,
            CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    let timeout = catalog
        .call(
            "mcp__a__read",
            Some(json!({"value":"wait"}).as_object().unwrap().clone()),
            CancellationToken::new(),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
    assert_eq!(
        timeout.effect_state,
        crate::tool_error::ToolEffectState::Unknown
    );
    assert!(catalog.healthy());
    catalog
        .call(
            "mcp__a__read",
            None,
            CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(
        catalog
            .call(
                "read",
                None,
                CancellationToken::new(),
                Duration::from_secs(1)
            )
            .await
            .is_err()
    );
    for mut client in clients {
        client.close().await.unwrap();
    }
    for mut server in servers {
        server.close().await.unwrap();
    }
}
