use rmcp::{
    RoleServer, ServerHandler, ServiceExt as _, handler::server::wrapper::Parameters, model::*,
    service::RequestContext, tool, tool_router,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use std::{
    borrow::Cow,
    process::Stdio,
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
    #[serde(default)]
    probe_paths: Vec<String>,
    #[serde(default)]
    cache_probe: bool,
}

#[derive(Deserialize, JsonSchema)]
struct ProgressInput {
    gate: String,
    #[serde(default)]
    fail: bool,
}

#[tool_router]
impl Fixture {
    #[tool(description = "Report progress before a test-controlled completion")]
    async fn progress(
        &self,
        Parameters(input): Parameters<ProgressInput>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let token = context.meta.get_progress_token().unwrap();
        std::fs::write(
            format!("{}-started", input.gate),
            serde_json::to_vec(&context.id).unwrap(),
        )
        .unwrap();
        context
            .peer
            .notify_progress(
                ProgressNotificationParam::new(token.clone(), 0.5)
                    .with_total(2.0)
                    .with_message("progress-payload-canary"),
            )
            .await
            .unwrap();
        loop {
            if std::path::Path::new(&format!("{}-release", input.gate)).exists() {
                break;
            }
            tokio::select! {
                _ = context.ct.cancelled() => {
                    std::fs::write(format!("{}-canceled", input.gate), b"canceled").unwrap();
                    return CallToolResult::error(vec![ContentBlock::text("canceled")]);
                },
                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {},
            }
        }
        context
            .peer
            .notify_progress(
                ProgressNotificationParam::new(token, 2.0)
                    .with_total(2.0)
                    .with_message("last"),
            )
            .await
            .unwrap();
        if input.fail {
            CallToolResult::error(vec![ContentBlock::text("controlled failure")])
        } else {
            CallToolResult::success(vec![ContentBlock::text("done")])
        }
    }

    #[tool(description = "Echo a value and report the isolated process identity")]
    async fn echo(&self, Parameters(input): Parameters<Echo>) -> CallToolResult {
        use std::os::unix::fs::MetadataExt as _;
        let uid = nix::unistd::getuid().as_raw();
        let home = std::env::var("HOME").unwrap();
        let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let config = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
        let cache = std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| format!("{home}/.cache"));
        let filename = format!("mcp-{uid}-credential.cache");
        let paths = if input.cache_probe {
            [&home, &tmp, &config, &cache, &"/tmp".into()]
                .map(|directory| {
                    std::fs::create_dir_all(directory).unwrap();
                    format!("{directory}/{filename}")
                })
                .to_vec()
        } else {
            Vec::new()
        };
        let secret = std::env::var("FIXTURE_SECRET").unwrap_or_else(|_| "cache-canary".into());
        for path in &paths {
            std::fs::write(path, &secret).unwrap();
        }
        let cached_execution = if input.cache_probe {
            use std::os::unix::fs::PermissionsExt as _;
            let executable = format!("{cache}/mcp-{uid}-program");
            std::fs::write(&executable, b"#!/bin/sh\nprintf cache-exec-ok\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::process::Command::new(executable)
                .output()
                .is_ok_and(|result| result.status.success() && result.stdout == b"cache-exec-ok")
        } else {
            false
        };
        CallToolResult::structured(json!({
            "value": input.value,
            "calls": self.calls.fetch_add(1, Ordering::SeqCst) + 1,
            "pid": std::process::id(), "uid": nix::unistd::getuid().as_raw(),
            "gid": nix::unistd::getgid().as_raw(), "home": std::env::var("HOME").unwrap(),
            "explicit_env": std::env::var("FIXTURE_SECRET").is_ok(),
            "supervisor_env": std::env::var("ANTNEST_RUNTIME_SPEC").is_ok(),
            "launcher_env": std::env::var("ANTNEST_MANAGED_MCP_CONFIG").is_ok(),
            "cwd": std::env::current_dir().unwrap(),
            "cache_paths": paths,
            "cache_executable_ok": cached_execution,
            "cache_modes": paths.iter().map(|path| std::fs::metadata(path).unwrap().mode() & 0o777).collect::<Vec<_>>(),
            "cache_owned_and_readable": paths.iter().all(|path| std::fs::metadata(path).unwrap().uid() == uid && std::fs::read_to_string(path).unwrap() == secret),
            "peer_cache_readable": input.probe_paths.iter().map(|path| std::fs::read(path).is_ok()).collect::<Vec<_>>(),
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

    #[tool(description = "Start a child that remains alive after this tool returns")]
    async fn spawn_worker(&self) -> CallToolResult {
        let mut child = match tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => {
                return CallToolResult::error(vec![ContentBlock::text("worker spawn failed")]);
            }
        };
        let Some(pid) = child.id() else {
            let _ = child.kill().await;
            return CallToolResult::error(vec![ContentBlock::text("worker PID missing")]);
        };
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        CallToolResult::structured(json!({ "pid": pid }))
    }

    #[tool(description = "Crash this test MCP process")]
    async fn crash(&self) -> CallToolResult {
        std::process::exit(23)
    }
}

#[rmcp::tool_handler]
impl ServerHandler for Fixture {
    async fn on_cancelled(
        &self,
        notification: CancelledNotificationParam,
        _: rmcp::service::NotificationContext<RoleServer>,
    ) {
        std::fs::write(
            "cancel-received",
            serde_json::to_vec(&notification.request_id).unwrap(),
        )
        .unwrap();
    }

    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
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

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::service::ClientLifecycleMode;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn fixture_accepts_runtime_auto_negotiation_and_lists_tools() {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let server = tokio::spawn(async move { Fixture::default().serve(server_io).await });
        let client = tokio::time::timeout(
            Duration::from_secs(2),
            rmcp::service::serve_client_with_lifecycle_and_ct(
                (),
                client_io,
                ClientLifecycleMode::Auto {
                    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                    legacy_version: Some(ProtocolVersion::V_2025_11_25),
                },
                CancellationToken::new(),
            ),
        )
        .await;
        let client = client
            .expect("fixture handshake deadline")
            .expect("fixture handshake failed");
        let tools = tokio::time::timeout(Duration::from_secs(2), client.list_all_tools())
            .await
            .expect("fixture catalog deadline")
            .expect("fixture catalog failed");
        assert!(tools.iter().any(|tool| tool.name == "echo"));
        client.cancel().await.unwrap();
        let service = server.await.unwrap().unwrap();
        service.cancel().await.unwrap();
    }
}
