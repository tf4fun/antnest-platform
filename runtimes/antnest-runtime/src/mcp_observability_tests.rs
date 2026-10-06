use super::*;
#[cfg(target_os = "linux")]
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use tracing_subscriber::prelude::*;

#[test]
fn http_disconnect_diagnostics_require_successful_protocol_completion() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("http-completion-test")));
    crate::test_tracing::stabilize_callsite_registry();
    let _guard = tracing::subscriber::set_default(subscriber);
    for (status, succeeded, failed, termination, expected_error, expected_cancel) in [
        (
            200,
            true,
            false,
            BodyTermination::ClientDisconnected,
            None,
            true,
        ),
        (
            200,
            false,
            false,
            BodyTermination::ClientDisconnected,
            Some("client_disconnected"),
            false,
        ),
        (200, true, false, BodyTermination::EndOfStream, None, false),
        (
            200,
            true,
            false,
            BodyTermination::BodyError,
            Some("http_body_error"),
            false,
        ),
        (
            500,
            true,
            false,
            BodyTermination::ClientDisconnected,
            Some("http_server_error"),
            false,
        ),
        (
            400,
            true,
            false,
            BodyTermination::ClientDisconnected,
            Some("http_client_error"),
            false,
        ),
        (
            200,
            false,
            true,
            BodyTermination::ClientDisconnected,
            Some("tool_failed"),
            false,
        ),
    ] {
        exporter.reset();
        let span = tracing::info_span!(
            "runtime.http",
            otel.status_code = tracing::field::Empty,
            "http.transport.outcome" = tracing::field::Empty,
            "error.type" = tracing::field::Empty
        );
        let observation = HttpObservation::new(span.clone());
        observation
            .protocol_succeeded
            .store(succeeded, Ordering::Relaxed);
        observation.protocol_failed.store(failed, Ordering::Relaxed);
        if failed {
            observation.span.set_attribute("error.type", "tool_failed");
        }
        let mut completion = HttpCompletion::new(
            span,
            RuntimeIdentity::new("test", 1).unwrap(),
            Method::POST,
            "/mcp",
            StatusCode::from_u16(status).unwrap(),
            RuntimeMetrics::default(),
            Instant::now(),
        );
        completion.observation = Some(observation);
        completion.finish(termination);
        provider.force_flush().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        let span = &spans[0];
        let error_type = span
            .attributes
            .iter()
            .find(|a| a.key.as_str() == "error.type")
            .map(|a| a.value.as_str().into_owned());
        assert_eq!(
            error_type.as_deref(),
            expected_error,
            "{status} {termination:?}"
        );
        assert_eq!(
            span.events
                .iter()
                .any(|event| event.name == "antnest.cancelled"),
            expected_cancel
        );
        assert_eq!(
            span.events
                .iter()
                .any(|event| event.name == "antnest.error"),
            expected_error.is_some() && !failed
        );
        assert_eq!(
            matches!(span.status, opentelemetry::trace::Status::Error { .. }),
            failed || status >= 500 || termination == BodyTermination::BodyError
        );
    }
    provider.shutdown().unwrap();
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/integration/antnest-runtime/mcp_http_observability.rs"
));

#[tokio::test]
async fn request_capture_counts_consumed_bytes_without_caching_content() {
    let size = 24 * 1024;
    let observation = HttpObservation::new(tracing::info_span!("request-count"));
    let body = RequestBody {
        inner: Box::pin(Body::from(vec![b'x'; size])),
        observation: observation.clone(),
    };
    assert_eq!(observation.request_bytes.load(Ordering::Relaxed), 0);
    let bytes = axum::body::to_bytes(Body::new(body), size).await.unwrap();
    assert_eq!(bytes.len(), size);
    assert_eq!(
        observation.request_bytes.load(Ordering::Relaxed),
        size as u64
    );
}

#[tokio::test]
async fn streaming_wrapper_does_not_poll_before_demand_and_preserves_errors() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let polls = Arc::new(AtomicUsize::new(0));
    let counter = polls.clone();
    let stream = futures_util::stream::poll_fn(move |_| {
        counter.fetch_add(1, Ordering::Relaxed);
        Poll::Ready(Some(Err::<Bytes, _>(std::io::Error::other(
            "STREAM_CANARY",
        ))))
    });
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let body = ObservedBody::with_probe(
        Body::from_stream(stream),
        tracing::info_span!("stream-test"),
        sender,
    );
    assert_eq!(polls.load(Ordering::Relaxed), 0);
    assert!(axum::body::to_bytes(Body::new(body), 16).await.is_err());
    assert_eq!(polls.load(Ordering::Relaxed), 1);
    assert_eq!(events.recv().await, Some(BodyTermination::BodyError));
    assert!(events.try_recv().is_err());
}
