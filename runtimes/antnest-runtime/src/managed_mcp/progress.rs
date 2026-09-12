use crate::progress::{ProgressSink, ProgressUpdate};
use rmcp::model::{
    JsonRpcMessage, ProgressNotificationParam, ProgressToken, ServerJsonRpcMessage,
    ServerNotification,
};
use tokio::sync::broadcast;

const CAPACITY: usize = 32;

#[derive(Clone)]
pub(crate) struct ProgressSource(broadcast::Sender<ProgressNotificationParam>);

impl Default for ProgressSource {
    fn default() -> Self {
        Self(broadcast::channel(CAPACITY).0)
    }
}

impl ProgressSource {
    pub(super) fn observe(&self, frame: &ServerJsonRpcMessage) {
        let JsonRpcMessage::Notification(notification) = frame else {
            return;
        };
        let ServerNotification::ProgressNotification(notification) = &notification.notification
        else {
            return;
        };
        let params = &notification.params;
        // Our SDK-generated tokens are small; unrelated child tokens must not
        // bypass the bounded preview buffer through oversized identity strings.
        if matches!(&params.progress_token.0, rmcp::model::NumberOrString::String(token) if token.len() > 128)
        {
            return;
        }
        let mut bounded = ProgressUpdate {
            progress: params.progress,
            total: params.total,
            message: params.message.clone(),
        };
        bounded.bound_message();
        let mut update =
            ProgressNotificationParam::new(params.progress_token.clone(), bounded.progress);
        update.total = bounded.total;
        update.message = bounded.message;
        // No active observer is normal during discovery and between calls.
        let _unobserved = self.0.send(update);
    }

    pub(super) fn listen(&self, sink: ProgressSink) -> PendingProgress {
        PendingProgress {
            receiver: self.0.subscribe(),
            sink,
            lagged: false,
            ended: false,
        }
    }
}

pub(super) struct PendingProgress {
    receiver: broadcast::Receiver<ProgressNotificationParam>,
    sink: ProgressSink,
    lagged: bool,
    ended: bool,
}

impl PendingProgress {
    pub(super) async fn next(&mut self, token: &ProgressToken) {
        match self.receiver.recv().await {
            Ok(update) => self.forward(update, token),
            Err(broadcast::error::RecvError::Lagged(_)) => self.lagged = true,
            Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
        }
    }

    pub(super) fn drain(&mut self, token: &ProgressToken) {
        for _ in 0..=CAPACITY {
            match self.receiver.try_recv() {
                Ok(update) => self.forward(update, token),
                Err(broadcast::error::TryRecvError::Lagged(_)) => self.lagged = true,
                Err(_) => break,
            }
        }
    }

    fn forward(&mut self, update: ProgressNotificationParam, token: &ProgressToken) {
        if self.ended || &update.progress_token != token {
            return;
        }
        let message = if self.lagged {
            self.ended = true;
            Some("Live progress truncated; see the final tool result.".into())
        } else {
            update.message
        };
        self.sink.emit(ProgressUpdate {
            progress: update.progress,
            total: update.total,
            message,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::ProgressSource;
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
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
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

    #[test]
    fn oversized_unrelated_tokens_cannot_fill_the_progress_buffer() {
        let source = ProgressSource::default();
        let mut receiver = source.0.subscribe();
        source.observe(
            &serde_json::from_value(serde_json::json!({
                "jsonrpc": "2.0", "method": "notifications/progress",
                "params": {"progressToken": "x".repeat(8192), "progress": 1}
            }))
            .unwrap(),
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }
}
