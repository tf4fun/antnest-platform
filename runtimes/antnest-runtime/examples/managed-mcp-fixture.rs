use rmcp::{
    RoleServer, ServerHandler, ServiceExt as _, handler::server::wrapper::Parameters, model::*,
    service::RequestContext, tool, tool_router,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::{
    borrow::Cow,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone, Default)]
struct Fixture {
    calls: Arc<AtomicUsize>,
    duplicate: bool,
}

#[derive(Deserialize, JsonSchema)]
struct Echo {
    value: String,
}

#[tool_router]
impl Fixture {
    #[tool(description = "Echo a value and report the isolated process identity")]
    async fn echo(&self, Parameters(input): Parameters<Echo>) -> CallToolResult {
        CallToolResult::structured(json!({
            "value": input.value,
            "calls": self.calls.fetch_add(1, Ordering::SeqCst) + 1,
            "pid": std::process::id(), "uid": nix::unistd::getuid().as_raw(),
            "gid": nix::unistd::getgid().as_raw(), "home": std::env::var("HOME").unwrap(),
            "explicit_env": std::env::var("FIXTURE_SECRET").is_ok(),
            "supervisor_env": std::env::var("ANTNEST_RUNTIME_SPEC").is_ok(),
            "launcher_env": std::env::var("ANTNEST_MANAGED_MCP_CONFIG").is_ok(),
        }))
    }

    #[tool(description = "Return a controlled tool error")]
    async fn fail(&self) -> CallToolResult {
        CallToolResult::error(vec![ContentBlock::text("fixture tool failed")])
    }

    #[tool(description = "Wait until the caller cancels this operation")]
    async fn wait(&self, context: RequestContext<RoleServer>) -> CallToolResult {
        std::fs::write("wait-started", b"started").unwrap();
        context.ct.cancelled().await;
        std::fs::write("wait-canceled", b"canceled").unwrap();
        CallToolResult::error(vec![ContentBlock::text("fixture canceled")])
    }

    #[tool(description = "Crash this test MCP process")]
    async fn crash(&self) -> CallToolResult {
        std::process::exit(23)
    }
}

#[rmcp::tool_handler]
impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2025_11_25])
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        assert_eq!(
            context.client_capabilities().unwrap(),
            ClientCapabilities::default()
        );
        let mut tools = Self::tool_router().list_all();
        if self.duplicate {
            tools.push(tools[0].clone());
        }
        Ok(ListToolsResult::with_all_items(tools))
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "requires-network" {
        // The isolated UDP fixture resets this synthetic destination. A refused
        // connection proves that TUN forwarding ran before MCP initialization.
        let error = std::net::TcpStream::connect_timeout(
            &"192.0.2.123:80".parse().unwrap(),
            std::time::Duration::from_secs(3),
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionRefused);
    }
    if mode == "no-init" {
        std::future::pending::<()>().await;
    }
    eprintln!("fixture-stderr-canary");
    let fixture = Fixture {
        duplicate: mode == "duplicate",
        ..Fixture::default()
    };
    let service = fixture
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .unwrap();
    service.waiting().await.unwrap();
}
