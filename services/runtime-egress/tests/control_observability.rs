mod support;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt as _;
use opentelemetry::{
    global,
    trace::{SpanKind, TracerProvider as _},
};
use opentelemetry_sdk::{
    propagation::TraceContextPropagator,
    trace::{InMemorySpanExporter, SdkTracerProvider, SpanData},
};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use tracing::instrument::WithSubscriber as _;
use tracing_subscriber::layer::SubscriberExt as _;

fn attribute(span: &SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|item| item.key.as_str() == key)
        .map(|item| item.value.to_string())
}

fn event_attribute(span: &SpanData, name: &str, key: &str) -> Option<String> {
    span.events
        .iter()
        .find(|event| event.name == name)
        .and_then(|event| {
            event
                .attributes
                .iter()
                .find(|item| item.key.as_str() == key)
        })
        .map(|item| item.value.to_string())
}

fn payload(span: &SpanData, direction: &str) -> Value {
    serde_json::from_str(&event_attribute(span, direction, "antnest.payload.json").unwrap())
        .unwrap()
}

#[tokio::test]
async fn control_rpc_contents_preserve_values_without_changing_responses() {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default().with(
        tracing_opentelemetry::layer().with_tracer(provider.tracer("egress-diagnostic-test")),
    );
    async {
        let app = support::app_with_capture_rpc_content(true).await;
        let requests = [
            ("PUT", "/internal/agent-networks/agent-42", "".to_owned(), 200),
            ("PUT", "/internal/policies/team-deny/revisions/7", json!({"spec":{"schema_version":1,"action":"deny_all"}}).to_string(), 200),
            ("GET", "/internal/policies/team-deny/revisions/7", "".to_owned(), 200),
            ("PUT", "/internal/agent-policy-assignments/agent-42", json!({"policy_id":"team-deny","revision":7,"expected_resource_version":1}).to_string(), 200),
            ("PUT", "/internal/policies/team-deny/revisions/8", json!({"spec":{"schema_version":1,"action":"allow_all","provider":{"access_token":"NESTED_CANARY"}}}).to_string(), 400),
            ("PUT", "/internal/policies/team-deny/revisions/8", "{\"spec\":{\"token\":\"PARTIAL_CANARY".to_owned(), 400),
            ("PUT", "/internal/policies/team-deny/revisions/8", format!("{}{}", " ".repeat(16 * 1024), json!({"spec":{"schema_version":1,"action":"allow_all"}})), 413),
            ("GET", "/status?access_token=QUERY_CANARY", "".to_owned(), 404),
            ("POST", "/unknown/URL_CANARY", "{\"token\":\"UNKNOWN_CANARY\"}".to_owned(), 404),
            ("PUT", "/internal/agent-policy-assignments/agent-42", json!({"policy_id":"team-deny","revision":7,"expected_resource_version":99}).to_string(), 409),
        ];
        for (method, uri, body, status) in requests {
            let response = app.clone().oneshot(Request::builder().method(method).uri(uri)
                .header("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
                .header("content-type", "application/json")
                .header("authorization", "Bearer AUTH_CANARY")
                .header("cookie", "session=COOKIE_CANARY")
                .header("baggage", "secret=BAGGAGE_CANARY")
                .header("antnest-service-authorization", support::workload_header()).body(Body::from(body)).unwrap()).await.unwrap();
            assert_eq!(response.status().as_u16(), status);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert!(serde_json::from_slice::<Value>(&bytes).is_ok());
        }
        let response = app.oneshot(Request::put("/internal/policies/team-deny/revisions/9")
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .header("antnest-service-authorization", support::workload_header()).body(Body::from(json!({"spec":{"schema_version":1,"action":"allow_all"}}).to_string())).unwrap())
            .await.unwrap();
        // Encoding is rejected before typed content capture or policy mutation.
        assert_eq!(response.status().as_u16(), 415);
        response.into_body().collect().await.unwrap();

        let metadata_app = support::app().await;
        let response = metadata_app.oneshot(Request::put("/internal/agent-networks/agent-meta")
            .header("antnest-service-authorization", support::workload_header()).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.into_body().collect().await.unwrap();
        let denied = support::app_with_capture_rpc_content(true).await
            .oneshot(Request::put("/internal/policies/DENIED_AGENT_CANARY/revisions/1")
                .header("antnest-service-authorization", "Bearer WORKLOAD_AUTH_CANARY")
                .header("antnest-caller-context", "CCT_CANARY")
                .header("x-antnest-role", "ADMIN_CANARY")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"spec":{"secret":"DENIED_BODY_CANARY"}}"#)).unwrap()).await.unwrap();
        assert_eq!(denied.status().as_u16(), 401);
        denied.into_body().collect().await.unwrap();
    }.with_subscriber(subscriber).await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let requests: Vec<_> = spans
        .iter()
        .filter(|span| span.span_kind == SpanKind::Server)
        .collect();
    assert_eq!(requests.len(), 13);
    for span in &requests[..10] {
        assert_eq!(span.parent_span_id.to_string(), "00f067aa0ba902b7");
        assert_eq!(
            span.span_context.trace_id().to_string(),
            "4bf92f3577b34da6a3ce929d0e0e4736"
        );
        assert!(
            !span
                .attributes
                .iter()
                .any(|item| item.key.as_str().contains(".header."))
        );
    }
    assert_eq!(
        payload(requests[0], "antnest.response")["tunnel_ipv4"],
        "100.64.0.2"
    );
    assert_eq!(
        payload(requests[0], "antnest.response")["attachment_state"],
        "closed"
    );
    assert_eq!(
        payload(requests[0], "antnest.response")["egress_endpoint"]["port"],
        8092
    );
    assert_eq!(
        attribute(requests[0], "antnest.agent.id").as_deref(),
        Some("agent-42")
    );
    assert_eq!(
        payload(requests[1], "antnest.request")["spec"]["action"],
        "deny_all"
    );
    assert_eq!(
        payload(requests[2], "antnest.response")["spec"]["action"],
        "deny_all"
    );
    assert_eq!(
        payload(requests[3], "antnest.request")["expected_resource_version"],
        1
    );
    assert_eq!(payload(requests[3], "antnest.response")["revision"], 7);
    assert_eq!(
        attribute(requests[3], "antnest.policy.revision").as_deref(),
        Some("7")
    );
    for index in [4, 5, 6, 7, 8, 10, 11, 12] {
        assert!(
            event_attribute(requests[index], "antnest.request", "antnest.payload.json").is_none()
        );
    }
    assert_eq!(requests[7].name, "HTTP GET unmatched");
    assert!(event_attribute(requests[7], "antnest.response", "antnest.payload.json").is_none());
    assert_eq!(
        attribute(requests[9], "antnest.outcome").as_deref(),
        Some("rejected")
    );
    assert_eq!(
        payload(requests[9], "antnest.response")["code"],
        "resource_version_conflict"
    );
    assert!(
        event_attribute(requests[9], "antnest.error", "antnest.error.message")
            .unwrap()
            .contains("resource version")
    );
    let failure = requests[9]
        .events
        .iter()
        .find(|event| event.name == "antnest.error")
        .unwrap();
    for key in [
        "antnest.error.type",
        "antnest.error.stage",
        "antnest.error.code",
        "antnest.error.message",
    ] {
        assert!(
            matches!(
                failure
                    .attributes
                    .iter()
                    .find(|attribute| attribute.key.as_str() == key)
                    .map(|attribute| &attribute.value),
                Some(opentelemetry::Value::String(_))
            ),
            "{key}"
        );
    }
    assert_eq!(
        payload(requests[10], "antnest.response")["code"],
        "unsupported_media_type"
    );
    assert_eq!(
        payload(requests[12], "antnest.response")["code"],
        "service_unauthenticated"
    );
    assert!(event_attribute(requests[11], "antnest.response", "antnest.payload.json").is_none());
    let debug = format!("{spans:?}");
    for canary in [
        "NESTED_CANARY",
        "PARTIAL_CANARY",
        "QUERY_CANARY",
        "URL_CANARY",
        "UNKNOWN_CANARY",
        "AUTH_CANARY",
        "COOKIE_CANARY",
        "BAGGAGE_CANARY",
        "WORKLOAD_AUTH_CANARY",
        "CCT_CANARY",
        "ADMIN_CANARY",
        "DENIED_BODY_CANARY",
        "DENIED_AGENT_CANARY",
        support::workload_token(),
    ] {
        assert!(!debug.contains(canary), "leaked {canary}");
    }
    provider.shutdown().unwrap();
}

#[tokio::test]
async fn no_exporter_keeps_business_responses_and_context_available() {
    use opentelemetry::{propagation::TextMapPropagator as _, trace::TraceContextExt as _};
    use tracing_opentelemetry::OpenTelemetrySpanExt as _;
    let provider = SdkTracerProvider::builder().build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("disabled-export")));
    async {
        let carrier = std::collections::HashMap::from([(
            "traceparent".to_owned(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_owned(),
        )]);
        let parent = TraceContextPropagator::new().extract(&carrier);
        let span = tracing::info_span!("disabled-export-control", otel.kind = "server");
        span.set_parent(parent).unwrap();
        assert!(span.context().span().span_context().is_valid());
        assert_eq!(
            span.context().span().span_context().trace_id().to_string(),
            "4bf92f3577b34da6a3ce929d0e0e4736"
        );
        let response = support::app()
            .await
            .oneshot(
                Request::put("/internal/agent-networks/export-disabled")
                    .header("antnest-service-authorization", support::workload_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["agent_id"], "export-disabled");
        assert_eq!(body["tunnel_ipv4"], "100.64.0.2");
    }
    .with_subscriber(subscriber)
    .await;
    provider.shutdown().unwrap();
}

#[test]
fn forwarding_and_policy_decisions_are_unchanged_and_create_no_spans() {
    use antnest_runtime_egress::{
        dataplane::{AgentRoute, DataPlaneAction, DataPlaneEngine, NetworkSnapshot, RouteGate},
        domain::AgentId,
        policy::PolicySpec,
    };
    use std::time::{Duration, Instant};
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("packet-exclusion-test")));
    tracing::subscriber::with_default(subscriber, || {
        let packet: Vec<_> =
            "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000"
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
        for policy in [PolicySpec::allow_all(), PolicySpec::deny_all()] {
            let mut engine = DataPlaneEngine::new(
                NetworkSnapshot::from_routes([AgentRoute {
                    agent_id: AgentId::parse("packet-owner").unwrap(),
                    tunnel_ipv4: "100.96.0.10".parse().unwrap(),
                    assignment_version: 1,
                    policy: policy.compile("100.64.0.1".parse().unwrap()),
                    gate: RouteGate::Open,
                    runtime_endpoint: Some("10.0.0.2".parse().unwrap()),
                }]),
                1400,
                32,
                16,
                Duration::from_secs(60),
            );
            let action =
                engine.handle_uplink(&packet, "10.0.0.2:41000".parse().unwrap(), Instant::now());
            if policy == PolicySpec::allow_all() {
                assert_eq!(action, DataPlaneAction::WriteTun(packet.clone()));
                assert_eq!(engine.flow_count(), 1);
            } else {
                assert!(matches!(action, DataPlaneAction::SendUdp { .. }));
                assert_eq!(engine.flow_count(), 0);
            }
        }
    });
    provider.force_flush().unwrap();
    assert!(exporter.get_finished_spans().unwrap().is_empty());
    provider.shutdown().unwrap();
}
