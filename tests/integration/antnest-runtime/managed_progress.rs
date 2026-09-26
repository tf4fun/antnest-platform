use crate::managed_mcp::{catalog::Catalog, session};
use crate::progress::ProgressSink;
use rmcp::{RoleServer, ServerHandler, ServiceExt as _, model::*, service::RequestContext};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Fixture {
    release: Arc<Semaphore>,
    canceled: Arc<Semaphore>,
    tokens: Arc<Mutex<Vec<ProgressToken>>>,
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult::with_all_items(vec![Tool::new(
            "work",
            "work",
            Arc::new(
                serde_json::json!({"type":"object"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )]))
    }
    async fn call_tool(
        &self,
        _: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let token = context.meta.get_progress_token().unwrap();
        self.tokens.lock().unwrap().push(token.clone());
        context
            .peer
            .notify_progress(
                ProgressNotificationParam::new(
                    ProgressToken(NumberOrString::String("unrelated".into())),
                    1.0,
                )
                .with_message("wrong-call"),
            )
            .await
            .unwrap();
        context
            .peer
            .notify_progress(
                ProgressNotificationParam::new(token.clone(), 0.5)
                    .with_total(2.0)
                    .with_message("first"),
            )
            .await
            .unwrap();
        tokio::select! {
            permit = self.release.acquire() => permit.unwrap().forget(),
            _ = context.ct.cancelled() => {
                self.canceled.add_permits(1);
                return Ok(CallToolResult::error(vec![ContentBlock::text("cancelled")]).into());
            },
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
        Ok(CallToolResult::success(vec![ContentBlock::text("done")]).into())
    }
}

#[tokio::test]
async fn managed_progress_is_live_token_scoped_and_drained_before_result() {
    let release = Arc::new(Semaphore::new(0));
    let acknowledged = Arc::new(Semaphore::new(0));
    let fixture = Fixture {
        release: release.clone(),
        canceled: acknowledged.clone(),
        tokens: Default::default(),
    };
    let tokens = fixture.tokens.clone();
    let (client_io, server_io) = tokio::io::duplex(65536);
    let server = tokio::spawn(async move { fixture.serve(server_io).await.unwrap() });
    let source = ProgressSource::default();
    let (read, write) = tokio::io::split(client_io);
    let mut client = session::connect(read, write, CancellationToken::new(), source.clone())
        .await
        .unwrap();
    let mut server = server.await.unwrap();
    let mut catalog = Catalog::default();
    catalog
        .add_server("fixture", client.peer().clone(), source)
        .await
        .unwrap();
    for canceled in [false, true, false] {
        let (updates, mut received) = mpsc::unbounded_channel();
        let sink = ProgressSink::new(move |update| {
            let _closed = updates.send(update);
        });
        let cancel = CancellationToken::new();
        let run_cancel = cancel.clone();
        let owned = catalog.clone();
        let call = tokio::spawn(async move {
            owned
                .call_with_progress(
                    "mcp__fixture__work",
                    None,
                    run_cancel,
                    Duration::from_secs(3),
                    sink,
                )
                .await
        });
        let first = tokio::time::timeout(Duration::from_secs(1), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.progress, 0.5);
        assert_eq!(first.total, Some(2.0));
        assert_eq!(first.message.as_deref(), Some("first"));
        assert!(!call.is_finished());
        if canceled {
            cancel.cancel();
        } else {
            release.add_permits(1);
        }
        let result = tokio::time::timeout(Duration::from_secs(2), call)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.is_err(), canceled);
        if canceled {
            tokio::time::timeout(Duration::from_secs(1), acknowledged.acquire())
                .await
                .expect("child must observe the cancellation")
                .unwrap()
                .forget();
        }
        if !canceled {
            assert_eq!(
                received.recv().await.unwrap().message.as_deref(),
                Some("last")
            );
        }
        assert!(received.recv().await.is_none());
    }
    {
        let tokens = tokens.lock().unwrap();
        assert_ne!(tokens[0], tokens[1]);
    }
    client.close().await.unwrap();
    server.close().await.unwrap();
}
