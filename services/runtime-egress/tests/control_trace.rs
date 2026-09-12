// Keep process-global tracing state separate from uninstrumented HTTP tests.
mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt as _;
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_sdk::{
    propagation::TraceContextPropagator,
    trace::{InMemorySpanExporter, SdkTracerProvider},
};
use support::app;
use tower::ServiceExt as _;
use tracing::instrument::WithSubscriber as _;
use tracing_subscriber::layer::SubscriberExt as _;

#[tokio::test]
async fn policy_read_trace_preserves_the_incoming_parent_and_error_outcome() {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("egress-test")));
    async {
        let app = app().await;
        for (revision, expected) in [
            ("1", StatusCode::OK),
            ("2", StatusCode::NOT_FOUND),
            ("%FF", StatusCode::BAD_REQUEST),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!(
                        "/internal/policies/builtin%2Fallow-all/revisions/{revision}"
                    ))
                    .header(
                        "traceparent",
                        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                    )
                    .header("tracestate", "antnest=c3")
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            response.into_body().collect().await.unwrap();
        }
    }
    .with_subscriber(subscriber)
    .await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let requests = spans
        .iter()
        .filter(|span| span.name == "HTTP GET /internal/policies/{policy_id}/revisions/{revision}")
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 3);
    for (span, (status, error)) in requests.iter().zip([
        ("200", ""),
        ("404", "policy_revision_not_found"),
        ("400", "invalid_request"),
    ]) {
        assert_eq!(span.span_kind, opentelemetry::trace::SpanKind::Server);
        assert_eq!(
            span.span_context.trace_id().to_string(),
            "4bf92f3577b34da6a3ce929d0e0e4736"
        );
        assert_eq!(span.parent_span_id.to_string(), "00f067aa0ba902b7");
        assert_eq!(span.span_context.trace_state().get("antnest"), Some("c3"));
        for (key, value) in [
            ("http.request.method", "GET"),
            (
                "http.route",
                "/internal/policies/{policy_id}/revisions/{revision}",
            ),
            ("http.response.status_code", status),
            ("error.type", error),
        ] {
            assert_eq!(
                span.attributes
                    .iter()
                    .find(|attribute| attribute.key.as_str() == key)
                    .map(|attribute| attribute.value.to_string()),
                Some(value.to_owned()),
                "{key}"
            );
        }
        if status != "400" {
            assert!(
                span.attributes
                    .iter()
                    .any(|attribute| attribute.key.as_str() == "antnest.policy.id"
                        && attribute.value.to_string() == "builtin/allow-all")
            );
        }
    }
    provider.shutdown().unwrap();
}
