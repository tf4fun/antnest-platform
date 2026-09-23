use std::sync::{Arc, Mutex};

use crate::progress::{ProgressPolicy, ProgressSink, ProgressUpdate, Utf8Preview};

#[test]
fn preview_preserves_split_utf8_and_invalid_bytes() {
    let mut preview = Utf8Preview::default();
    assert_eq!(preview.push(&[b'a', 0xe4, 0xbd], false), "a");
    assert_eq!(preview.push(&[0xa0, 0xff, b'b'], false), "你\u{fffd}b");
    assert_eq!(preview.push(&[0xe4], false), "");
    assert_eq!(preview.push(&[], true), "\u{fffd}");
}

#[test]
fn progress_policy_bounds_messages_and_never_invents_totals() {
    let mut policy = ProgressPolicy::default();
    let update = policy
        .accept(
            ProgressUpdate {
                progress: 1.0,
                total: None,
                message: Some("你".repeat(8192)),
            },
            false,
        )
        .unwrap();
    let message = update.message.unwrap();
    assert!(message.len() <= 8192);
    assert!(
        message.capacity() <= 8192,
        "queued previews must release oversized backing storage"
    );
    assert!(update.total.is_none());
    assert!(
        policy
            .accept(ProgressUpdate::message(1.0, "duplicate"), false)
            .is_none()
    );
    assert!(
        policy
            .accept(ProgressUpdate::message(f64::NAN, "invalid"), false)
            .is_none()
    );
    let notice = policy
        .accept(ProgressUpdate::message(2.0, "overflow"), true)
        .unwrap();
    assert!(notice.message.unwrap().contains("truncated"));
    assert!(
        policy
            .accept(ProgressUpdate::message(3.0, "late"), false)
            .is_none()
    );
}

#[test]
fn progress_sink_is_optional_and_synchronous() {
    ProgressSink::default().emit(ProgressUpdate::message(1.0, "ignored"));
    let updates = Arc::new(Mutex::new(Vec::new()));
    let captured = updates.clone();
    let sink = ProgressSink::new(move |update| captured.lock().unwrap().push(update));
    sink.emit(ProgressUpdate::message(1.0, "stdout: first"));
    assert_eq!(updates.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn overloaded_progress_is_bounded_and_marked_without_blocking_the_producer() {
    use crate::progress::ProgressQueue;
    use std::sync::atomic::Ordering;
    let (sink, mut queue) = ProgressQueue::new();
    for value in 1..1000 {
        sink.emit(ProgressUpdate::message(value as f64, "preview"));
    }
    assert!(queue.overflowed.load(Ordering::Relaxed));
    assert_eq!(queue.receiver.len(), 32);
    let mut policy = ProgressPolicy::default();
    let notice = policy
        .accept(queue.receiver.recv().await.unwrap(), true)
        .unwrap();
    assert!(notice.message.unwrap().contains("truncated"));
    assert!(
        policy
            .accept(queue.receiver.recv().await.unwrap(), true)
            .is_none()
    );
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/integration/antnest-runtime/mcp_progress_transport.rs"
));

#[test]
fn report_budget_and_invalid_totals_do_not_create_fake_completion() {
    let mut policy = ProgressPolicy::default();
    assert!(
        policy
            .accept(
                ProgressUpdate {
                    progress: 2.0,
                    total: Some(1.0),
                    message: None
                },
                false
            )
            .is_none()
    );
    for value in 1..256 {
        assert_eq!(
            policy
                .accept(ProgressUpdate::message(value as f64, "preview"), false)
                .unwrap()
                .message
                .as_deref(),
            Some("preview")
        );
    }
    assert!(
        policy
            .accept(ProgressUpdate::message(256.0, "preview"), false)
            .unwrap()
            .message
            .unwrap()
            .contains("truncated")
    );
    assert!(
        policy
            .accept(ProgressUpdate::message(257.0, "preview"), false)
            .is_none()
    );
}

#[tokio::test]
async fn executor_progress_precedes_the_terminal_envelope() {
    use crate::executor_protocol::read_executor_output;
    use tokio::io::AsyncWriteExt as _;

    let (mut writer, reader) = tokio::io::duplex(4096);
    let (updates, mut received) = tokio::sync::mpsc::unbounded_channel();
    let sink = ProgressSink::new(move |update| {
        updates.send(update).unwrap();
    });
    let reading = tokio::spawn(read_executor_output(reader, sink));
    writer
        .write_all(b"{\"progress\":{\"progress\":3,\"message\":\"stdout: one\"}}\n")
        .await
        .unwrap();
    let update = tokio::time::timeout(std::time::Duration::from_secs(1), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(update.message.as_deref(), Some("stdout: one"));
    assert!(!reading.is_finished());
    writer
        .write_all(b"{\"status\":\"success\",\"result\":{}}\n")
        .await
        .unwrap();
    writer.shutdown().await.unwrap();
    let (result, truncated) = reading.await.unwrap().unwrap();
    assert!(!truncated);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result).unwrap()["status"],
        "success"
    );
}

#[tokio::test]
async fn executor_rejects_missing_duplicate_and_post_terminal_progress() {
    use crate::executor_protocol::read_executor_output;
    for input in [
        "",
        "{\"status\":\"success\",\"result\":{}}\n{\"status\":\"success\",\"result\":{}}\n",
        "{\"status\":\"success\",\"result\":{}}\n{\"progress\":{\"progress\":1}}\n",
    ] {
        assert!(
            read_executor_output(input.as_bytes(), ProgressSink::default())
                .await
                .is_err()
        );
    }
}
