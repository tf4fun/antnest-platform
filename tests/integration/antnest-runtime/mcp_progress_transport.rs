#[tokio::test]
async fn a_stalled_notification_transport_cannot_withhold_the_execution_result() {
    use rmcp::{
        RoleServer, ServerHandler,
        model::{NumberOrString, ProgressToken},
        service::{RequestContext, serve_directly},
    };
    use std::time::{Duration, Instant};

    struct Fixture;
    impl ServerHandler for Fixture {}

    // Keep the peer connected but never read: its 64-byte pipe cannot accept
    // even the first preview. Exercise the official SDK's blocked send path.
    let (unread_client, server_io) = tokio::io::duplex(64);
    let mut service = serve_directly::<RoleServer, _, _, _, _>(Fixture, server_io, None);
    let mut context = RequestContext::new(NumberOrString::Number(1), service.peer().clone());
    context
        .meta
        .set_progress_token(ProgressToken(NumberOrString::Number(1)));
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        crate::mcp_progress::with_progress(&context, |sink| async move {
            for value in 1..=32 {
                sink.emit(ProgressUpdate::message(value as f64, "x".repeat(8192)));
            }
            "authoritative result"
        }),
    )
    .await;
    let elapsed = started.elapsed();
    drop(unread_client);
    service.close().await.unwrap();
    assert_eq!(result.unwrap(), "authoritative result");
    assert!(
        elapsed >= Duration::from_secs(1),
        "the transport must actually reach its send deadline"
    );
}
