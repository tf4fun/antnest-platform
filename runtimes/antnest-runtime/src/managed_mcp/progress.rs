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

    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/integration/antnest-runtime/managed_progress.rs"
    ));

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
