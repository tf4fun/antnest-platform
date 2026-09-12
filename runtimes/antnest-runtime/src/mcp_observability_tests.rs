use super::*;
#[cfg(target_os = "linux")]
use opentelemetry::trace::{TraceContextExt as _, TracerProvider as _};
#[cfg(target_os = "linux")]
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
#[cfg(target_os = "linux")]
use tracing_subscriber::prelude::*;

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn real_http_health_and_mcp_keep_exact_client_parent_and_rpc_values() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry().with(
        tracing_opentelemetry::layer()
            .with_tracer(provider.tracer("runtime-boundary-test"))
            .with_filter(tracing_subscriber::filter::filter_fn(
                crate::telemetry::is_runtime_trace,
            )),
    );
    let _guard = tracing::subscriber::set_default(subscriber);
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let roots = Arc::new(NamedRoots::open(workspace.path(), skills.path()).unwrap());
    let mut server = RuntimeHttp::new_in_process(
        RuntimeStatus::with_execution_id(
            RuntimeIdentity::new("agent-test", 7).unwrap(),
            "execution-7",
        ),
        roots,
    );
    server.metrics = server.metrics.with_rpc_content(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let shutdown = CancellationToken::new();
    let task = tokio::spawn(server.serve(listener, shutdown.clone()));
    let client = reqwest::Client::new();
    let caller = tracing::info_span!("caller", otel.kind = "client");
    let context = caller.context();
    let span_context = context.span().span_context().clone();
    let traceparent = format!(
        "00-{}-{}-01",
        span_context.trace_id(),
        span_context.span_id()
    );
    let response = client
        .get(format!("http://{address}/status?token=QUERY_CANARY"))
        .header("traceparent", &traceparent)
        .header("cookie", "COOKIE_CANARY")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["execution_id"],
        "execution-7"
    );
    let response = client.post(format!("http://{address}/mcp"))
        .header("traceparent", &traceparent)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2026-07-28")
        .header("mcp-method", "tools/call")
        .header("mcp-name", "read")
        .header(EXPECTED_EXECUTION_HEADER, "execution-7")
        .json(&json!({"jsonrpc":"2.0", "id": 9, "method":"tools/call", "params": {
            "name":"read", "arguments":{"path":{"root":"workspace", "path":"missing-file"}, "offset":0, "limit":23},
            "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "io.modelcontextprotocol/clientInfo":{"name":"test", "version":"1"}}
        }})).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("isError"), "{body}");
    shutdown.cancel();
    task.await.unwrap().unwrap();
    drop(caller);
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    for name in ["HTTP GET /status", "HTTP POST /mcp"] {
        let span = spans.iter().find(|span| span.name == name).unwrap();
        assert_eq!(span.parent_span_id, span_context.span_id());
        assert_eq!(span.span_context.trace_id(), span_context.trace_id());
        assert_eq!(span.span_kind, opentelemetry::trace::SpanKind::Server);
    }
    let http = spans
        .iter()
        .find(|span| span.name == "HTTP POST /mcp")
        .unwrap();
    let operation = spans
        .iter()
        .find(|span| span.name == "runtime.mcp.operation")
        .unwrap();
    assert_eq!(operation.parent_span_id, http.span_context.span_id());
    assert!(matches!(
        operation.status,
        opentelemetry::trace::Status::Error { .. }
    ));
    assert!(matches!(
        http.status,
        opentelemetry::trace::Status::Error { .. }
    ));
    let request = operation
        .events
        .iter()
        .find(|event| event.name == "antnest.request")
        .unwrap();
    let payload = request
        .attributes
        .iter()
        .find(|attribute| attribute.key.as_str() == "antnest.payload.json")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload.value.as_str()).unwrap();
    assert_eq!(
        payload["params"]["arguments"]["path"]["path"],
        "missing-file"
    );
    assert_eq!(payload["params"]["arguments"]["limit"], 23);
    let response = operation
        .events
        .iter()
        .find(|event| event.name == "antnest.response")
        .unwrap();
    let payload = response
        .attributes
        .iter()
        .find(|attribute| attribute.key.as_str() == "antnest.payload.json")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload.value.as_str()).unwrap();
    assert_eq!(payload["isError"], true);
    assert_eq!(
        spans
            .iter()
            .filter(|span| span.name == "runtime.mcp.operation")
            .count(),
        1
    );
    assert!(!format!("{spans:?}").contains("CANARY"));
    assert!(
        !http
            .events
            .iter()
            .any(|event| event.name.starts_with("antnest.request")
                || event.name.starts_with("antnest.response"))
    );
    let status = spans
        .iter()
        .find(|span| span.name == "HTTP GET /status")
        .unwrap();
    assert!(!status.events.iter().any(|event| {
        event.name == "antnest.request"
            || event.name == "antnest.response"
            || event
                .attributes
                .iter()
                .any(|attribute| attribute.key.as_str().starts_with("antnest.payload."))
    }));
    assert!(
        !status
            .attributes
            .iter()
            .any(|attribute| attribute.key.as_str().contains(".header."))
    );
    provider.shutdown().unwrap();
}

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
