use super::*;
use opentelemetry::Value as OtelValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use tracing_subscriber::prelude::*;

fn attribute<'a>(attributes: &'a [KeyValue], key: &str) -> &'a OtelValue {
    &attributes
        .iter()
        .find(|item| item.key.as_str() == key)
        .unwrap()
        .value
}

#[test]
fn rpc_capture_preserves_nested_new_fields_without_a_payload_cap() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("capture")));
    let value = json!({
        "new_field": {"public": "x".repeat(24 * 1024), "token": "PRIVATE-CANARY"},
        "content": ["not projected"],
    });
    let original = value.clone();
    crate::test_tracing::stabilize_callsite_registry();
    tracing::subscriber::with_default(subscriber, || {
        let span = tracing::info_span!("rpc");
        rpc_content(&span, "antnest.request", true, &value);
        rpc_content(&span, "antnest.response", true, &value);
    });
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans[0].events.len(), 2);
    let expected = json!({
        "new_field": {"public": "x".repeat(24 * 1024), "token": "[REDACTED]"},
        "content": ["not projected"],
    });
    for event in spans[0].events.iter() {
        let raw = attribute(&event.attributes, "antnest.payload.json").as_str();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), expected);
    }
    assert_eq!(value, original);
}

#[test]
fn disabled_capture_never_serializes_values() {
    struct Unserializable;
    impl serde::Serialize for Unserializable {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            panic!("disabled capture serialized payload")
        }
    }
    rpc_content(
        &tracing::Span::none(),
        "antnest.request",
        false,
        &Unserializable,
    );
    rpc_content(
        &tracing::Span::none(),
        "antnest.request",
        true,
        &Unserializable,
    );
}

#[test]
fn typed_errors_keep_sources_but_export_only_safe_causes_and_string_codes() {
    use std::error::Error as _;
    let error = ToolError::new(ToolErrorCode::SpawnFailed, "PRIVATE_CANARY").with_source(
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "SOURCE_CANARY"),
    );
    assert!(
        error
            .source()
            .unwrap()
            .to_string()
            .contains("SOURCE_CANARY")
    );
    let attributes = tool_error_attributes("executor", &error);
    assert_eq!(
        attribute(&attributes, "antnest.error.code").as_str(),
        "spawn_failed"
    );
    assert!(format!("{attributes:?}").contains("permission_denied"));
    assert!(!format!("{attributes:?}").contains("CANARY"));
}

#[test]
fn protocol_200_is_error_is_not_success() {
    let result =
        ServerResult::CallToolResult(rmcp::model::CallToolResult::structured_error(json!({
            "error_code": "read_failed", "message": "REMOTE_ERROR"
        })));
    assert_eq!(protocol_error(Some("read"), &result), Some("read_failed"));
    assert_eq!(protocol_error(None, &result), Some("managed_tool_error"));
}

#[test]
fn rpc_capture_redacts_nested_secrets_without_changing_original() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("capture")));
    let value = json!({
        "public": "x".repeat(24 * 1024),
        "large": 9007199254740993u64,
        "nested": {"password": "PRIVATE-CANARY", "access_token": "PRIVATE-CANARY"},
        "rows": [{"client_secret": "PRIVATE-CANARY"}],
    });
    let original = value.clone();
    crate::test_tracing::stabilize_callsite_registry();
    tracing::subscriber::with_default(subscriber, || {
        let span = tracing::info_span!("rpc");
        rpc_content(&span, "antnest.request", true, &value);
        rpc_content(&span, "antnest.response", true, &value);
    });
    assert_eq!(value, original);
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].events.len(), 2);
    let names: Vec<_> = spans[0]
        .events
        .iter()
        .map(|event| event.name.to_string())
        .collect();
    assert_eq!(names, ["antnest.request", "antnest.response"]);
    for event in spans[0].events.iter() {
        let raw = attribute(&event.attributes, "antnest.payload.json").as_str();
        assert!(!raw.contains("PRIVATE-CANARY"));
        let captured: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(captured["public"], json!("x".repeat(24 * 1024)));
        assert_eq!(captured["large"], json!(9007199254740993u64));
        assert_eq!(captured["nested"]["password"], json!("[REDACTED]"));
        assert_eq!(captured["nested"]["access_token"], json!("[REDACTED]"));
        assert_eq!(captured["rows"][0]["client_secret"], json!("[REDACTED]"));
    }
}
