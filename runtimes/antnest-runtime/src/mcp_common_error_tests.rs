use super::*;
use axum::http::HeaderMap;
use std::time::Instant;

fn identity() -> RuntimeIdentity {
    RuntimeIdentity::new("agent-1", 1).expect("identity")
}

async fn failure_body(response: Response) -> (StatusCode, HeaderMap, serde_json::Value) {
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("failure body");
    (
        status,
        headers,
        serde_json::from_slice(&bytes).expect("failure body is JSON"),
    )
}

fn assert_common_error(
    headers: &HeaderMap,
    body: &serde_json::Value,
    code: &str,
    category: &str,
    retryable: bool,
) {
    let request_id = headers
        .get("x-request-id")
        .expect("x-request-id header")
        .to_str()
        .expect("ascii request id");
    assert!(request_id.chars().all(|c| c.is_ascii_alphanumeric()
        || c == '.'
        || c == '_'
        || c == ':'
        || c == '-'));
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    for envelope in [body, &body["error"]] {
        assert_eq!(envelope["code"], serde_json::json!(code));
        assert_eq!(envelope["category"], serde_json::json!(category));
        assert_eq!(envelope["retryable"], serde_json::json!(retryable));
        assert_eq!(envelope["request_id"], serde_json::json!(request_id));
    }
    assert!(!body.to_string().contains("private-canary"));
}

#[tokio::test]
async fn common_error_maintenance_error_conflict() {
    let (status, headers, body) =
        failure_body(maintenance_error(StatusCode::CONFLICT, "request_conflict")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_common_error(&headers, &body, "request_conflict", "conflict", false);
    assert_eq!(
        body["message"],
        serde_json::json!("Skill maintenance request was not admitted")
    );
}

#[tokio::test]
async fn common_error_maintenance_error_unavailable() {
    let (status, headers, body) = failure_body(maintenance_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_busy",
    ))
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_common_error(&headers, &body, "runtime_busy", "unavailable", true);
}

#[tokio::test]
async fn common_error_execution_fence_duplicates_reason() {
    let (status, headers, body) = failure_body(execution_fence_response("stale")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body["code"],
        serde_json::json!("runtime_execution_mismatch")
    );
    assert_eq!(body["category"], serde_json::json!("conflict"));
    assert_eq!(body["reason"], serde_json::json!("stale"));
    assert_eq!(body["details"]["reason"], serde_json::json!("stale"));
    assert_eq!(body["retryable"], serde_json::json!(false));
    assert_eq!(
        body["request_id"].as_str().unwrap(),
        headers.get("x-request-id").unwrap()
    );
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
}

#[test]
fn common_error_tool_result_invalid_params() {
    let result = tool_result::<serde_json::Value>(
        "probe",
        &identity(),
        &RuntimeMetrics::default(),
        Instant::now(),
        Err(ToolError::invalid_params("invalid public input")),
    );
    let content = result.structured_content.expect("structured content");
    assert_eq!(content["error_code"], serde_json::json!("invalid_params"));
    assert_eq!(content["effect_state"], serde_json::json!("none"));
    assert_eq!(content["effect_source"], serde_json::Value::Null);
    assert_eq!(content["code"], serde_json::json!("invalid_params"));
    assert_eq!(content["category"], serde_json::json!("invalid_request"));
    assert_eq!(content["retryable"], serde_json::json!(false));
    let request_id = content["request_id"].as_str().expect("request_id");
    assert!(request_id.chars().all(|c| c.is_ascii_alphanumeric()
        || c == '.'
        || c == '_'
        || c == ':'
        || c == '-'));
}

#[test]
fn common_error_tool_result_outcome_unknown() {
    let result = tool_result::<serde_json::Value>(
        "probe",
        &identity(),
        &RuntimeMetrics::default(),
        Instant::now(),
        Err(ToolError::outcome_unknown("public message")),
    );
    let content = result.structured_content.expect("structured content");
    assert_eq!(content["code"], serde_json::json!("outcome_unknown"));
    assert_eq!(content["category"], serde_json::json!("internal"));
    assert_eq!(content["effect_state"], serde_json::json!("unknown"));
    assert_eq!(content["effect_source"], serde_json::json!("runtime_mcp"));
    assert_eq!(content["retryable"], serde_json::json!(false));
}

#[test]
fn common_error_reject_reserved_maintenance_tool() {
    let Err(error) = reject_reserved_maintenance_tool("antnest_skill_maintenance_x") else {
        panic!("reserved name must be rejected");
    };
    assert_eq!(error.code, rmcp::model::ErrorCode::INVALID_PARAMS);
    assert_eq!(error.message.as_ref(), "Reserved maintenance tool name");
    let data = error.data.expect("common error data");
    assert_eq!(data["code"], serde_json::json!("invalid_params"));
    assert_eq!(data["category"], serde_json::json!("invalid_request"));
    assert_eq!(data["retryable"], serde_json::json!(false));
    let request_id = data["request_id"].as_str().expect("request_id");
    assert!(request_id.chars().all(|c| c.is_ascii_alphanumeric()
        || c == '.'
        || c == '_'
        || c == ':'
        || c == '-'));
}

struct Uncooperative;

impl serde::Serialize for Uncooperative {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("private-canary"))
    }
}

#[test]
fn common_error_tool_result_serialization_cause_sanitized() {
    let result = tool_result::<Uncooperative>(
        "probe",
        &identity(),
        &RuntimeMetrics::default(),
        Instant::now(),
        Ok(Uncooperative),
    );
    let content = result.structured_content.expect("structured content");
    assert_eq!(content["code"], serde_json::json!("encode_result_failed"));
    assert_eq!(
        content["error_code"],
        serde_json::json!("encode_result_failed")
    );
    assert_eq!(content["category"], serde_json::json!("internal"));
    assert_eq!(
        content["message"],
        serde_json::json!("Runtime tool result could not be encoded")
    );
    assert_eq!(content["retryable"], serde_json::json!(false));
    assert_eq!(content["effect_state"], serde_json::json!("settled"));
    assert_eq!(content["effect_source"], serde_json::Value::Null);
    let request_id = content["request_id"].as_str().expect("request_id");
    assert!(request_id.chars().all(|c| c.is_ascii_alphanumeric()
        || c == '.'
        || c == '_'
        || c == ':'
        || c == '-'));
    assert!(!content.to_string().contains("private-canary"));
}

#[test]
fn common_error_protocol_error_numeric_mapping() {
    for (numeric, want) in [
        (-32_602, "invalid_params"),
        (-32_601, "not_found"),
        (-32_002, "not_found"),
        (-32_600, "invalid_request"),
        (-32_700, "invalid_request"),
        (-32_022, "invalid_request"),
        (-32_021, "invalid_request"),
        (-32_020, "invalid_request"),
        (-32_603, "internal"),
        (-1, "internal"),
    ] {
        let error = common_protocol_error(
            rmcp::ErrorData::new(rmcp::model::ErrorCode(numeric), "outer", None),
            "req-1",
        );
        assert_eq!(error.code.0, numeric, "outer numeric code preserved");
        assert_eq!(error.message.as_ref(), "outer");
        let data = error.data.expect("common data");
        assert_eq!(data["code"], serde_json::json!(want), "numeric {}", numeric);
        assert_eq!(data["request_id"], serde_json::json!("req-1"));
        assert!(
            data["request_id"]
                .as_str()
                .unwrap()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == ':' || c == '-')
        );
    }
}

#[test]
fn common_error_protocol_error_drops_arbitrary_data() {
    let error = common_protocol_error(
        rmcp::ErrorData::new(
            rmcp::model::ErrorCode(-32_602),
            "outer",
            Some(serde_json::json!({"cause": "private-canary", "hint": "drop me"})),
        ),
        "req-1",
    );
    let data = error.data.expect("common data");
    assert_eq!(data["code"], serde_json::json!("invalid_params"));
    assert!(data.get("cause").is_none() && data.get("hint").is_none());
    assert!(!data.to_string().contains("private-canary"));
}

#[test]
fn common_error_protocol_error_keeps_registered_error_code() {
    let error = common_protocol_error(
        rmcp::ErrorData::new(
            rmcp::model::ErrorCode(-32_603),
            "outer",
            Some(serde_json::json!({"error_code": "outcome_unknown"})),
        ),
        "req-1",
    );
    let data = error.data.expect("common data");
    assert_eq!(data["code"], serde_json::json!("outcome_unknown"));
    assert_eq!(data["category"], serde_json::json!("internal"));
    assert_eq!(data["error_code"], serde_json::json!("outcome_unknown"));
}

#[test]
fn common_error_protocol_error_rejects_unregistered_error_code() {
    let error = common_protocol_error(
        rmcp::ErrorData::new(
            rmcp::model::ErrorCode(-32_603),
            "outer",
            Some(serde_json::json!({"error_code": "private-canary"})),
        ),
        "req-1",
    );
    let data = error.data.expect("common data");
    assert_eq!(data["code"], serde_json::json!("internal"));
    assert_eq!(
        data["message"],
        serde_json::json!("MCP operation failed internally")
    );
    assert!(data.get("error_code").is_none());
}

#[test]
fn common_error_tool_error_code_metadata_parity() {
    for code in ToolErrorCode::ALL {
        let name = code.as_str();
        assert!(
            crate::api_errors_gen::metadata(name).is_some(),
            "tool error code {} is not registered",
            name
        );
    }
}

#[tokio::test]
async fn common_error_managed_unavailable_response() {
    let response = managed_unavailable_response();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let request_id = response
        .headers()
        .get("x-request-id")
        .expect("x-request-id header")
        .to_str()
        .expect("ascii request id")
        .to_owned();
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("failure body");
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("failure body is JSON");
    assert_eq!(body["code"], serde_json::json!("runtime_unavailable"));
    assert_eq!(body["category"], serde_json::json!("unavailable"));
    assert_eq!(
        body["message"],
        serde_json::json!("A required managed MCP service is unavailable")
    );
    assert_eq!(body["retryable"], serde_json::json!(true));
    assert_eq!(body["request_id"], serde_json::json!(request_id));
}

#[test]
fn common_error_generated_request_id_safety() {
    let envelope = crate::api_errors_gen::envelope(
        crate::api_errors_gen::INVALID_PARAMS,
        "probe",
        "request-42.safe",
        false,
    );
    assert_eq!(envelope["request_id"], serde_json::json!("request-42.safe"));
    let envelope = crate::api_errors_gen::envelope(
        crate::api_errors_gen::INVALID_PARAMS,
        "probe",
        "bad id with spaces",
        false,
    );
    let request_id = envelope["request_id"].as_str().expect("request_id");
    assert_ne!(request_id, "bad id with spaces");
    assert!(request_id.chars().all(|c| c.is_ascii_alphanumeric()
        || c == '.'
        || c == '_'
        || c == ':'
        || c == '-'));
}

#[test]
fn common_error_literal_producer_codes_forbidden() {
    let scan = |source: &str, names: &[&str]| -> Vec<usize> {
        let mut problems = Vec::new();
        for name in names {
            let token = format!("{}(", name);
            let mut offset = 0usize;
            while let Some(position) = source[offset..].find(&token) {
                let start = offset + position;
                let before = source.as_bytes().get(start.wrapping_sub(1)).copied();
                if matches!(before, Some(b) if b.is_ascii_alphanumeric() || b == b'_') {
                    offset = start + token.len();
                    continue;
                }
                let rest = &source[start + token.len()..];
                if let Some(comma) = rest.find(',')
                    && rest[comma + 1..].trim_start().starts_with('"')
                {
                    problems.push(start);
                }
                offset = start + token.len();
            }
        }
        problems
    };
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, names) in [
        ("service_auth.rs", &["rejection"][..]),
        ("mcp.rs", &["maintenance_error"][..]),
        ("skill_temporary_http.rs", &["failure"][..]),
    ] {
        let source = std::fs::read_to_string(manifest.join(file)).expect(file);
        assert!(
            scan(&source, names).is_empty(),
            "{} has literal producer codes",
            file
        );
    }
    assert_eq!(
        scan(
            "rejection(StatusCode::UNAUTHORIZED, \"runtime_unauthorized\")",
            &["rejection"]
        )
        .len(),
        1
    );
    assert_eq!(
        scan(
            "maintenance_error(\n    StatusCode::CONFLICT,\n    \"request_conflict\",\n)",
            &["maintenance_error"]
        )
        .len(),
        1
    );
    assert_eq!(
        scan(
            "rejection(StatusCode::UNAUTHORIZED, crate::api_errors_gen::RUNTIME_UNAUTHORIZED)",
            &["rejection"]
        )
        .len(),
        0
    );
}
