use std::{future::Future, sync::atomic::Ordering, time::Duration};

use rmcp::{RoleServer, model::ProgressNotificationParam, service::RequestContext};

use crate::progress::{ProgressPolicy, ProgressQueue, ProgressSink, ProgressUpdate};

const SEND_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) async fn with_progress<T, F: Future<Output = T>>(
    context: &RequestContext<RoleServer>,
    execute: impl FnOnce(ProgressSink) -> F,
) -> T {
    let Some(token) = context.meta.get_progress_token() else {
        return execute(ProgressSink::default()).await;
    };
    let (sink, mut queue) = ProgressQueue::new();
    let call = execute(sink);
    tokio::pin!(call);
    let mut policy = ProgressPolicy::default();
    let mut deliver = true;
    let result = loop {
        tokio::select! {
            result = &mut call => break result,
            update = queue.receiver.recv(), if deliver => {
                let Some(update) = update else { deliver = false; continue; };
                deliver = send(context, &token, &mut policy, &queue, update).await;
                if !deliver { queue.receiver.close(); }
            }
        }
    };
    queue.receiver.close();
    // A final result must not wait indefinitely behind a slow preview consumer.
    if deliver
        && tokio::time::timeout(SEND_TIMEOUT, async {
            while let Ok(update) = queue.receiver.try_recv() {
                if !send(context, &token, &mut policy, &queue, update).await {
                    break;
                }
            }
        })
        .await
        .is_err()
    {
        tracing::warn!(error.type = "progress_delivery_timeout", "Tool progress tail was not delivered");
    }
    result
}

async fn send(
    context: &RequestContext<RoleServer>,
    token: &rmcp::model::ProgressToken,
    policy: &mut ProgressPolicy,
    queue: &ProgressQueue,
    update: ProgressUpdate,
) -> bool {
    if context.ct.is_cancelled() {
        return false;
    }
    let Some(update) = policy.accept(update, queue.overflowed.load(Ordering::Relaxed)) else {
        return true;
    };
    let mut notification = ProgressNotificationParam::new(token.clone(), update.progress);
    notification.total = update.total;
    notification.message = update.message;
    let result = tokio::select! {
        _ = context.ct.cancelled() => return false,
        result = tokio::time::timeout(SEND_TIMEOUT, context.peer.notify_progress(notification)) => result,
    };
    if matches!(result, Ok(Ok(()))) {
        return true;
    }
    tracing::warn!(error.type = "progress_delivery_failed", "Tool progress delivery stopped; execution result remains authoritative");
    false
}
