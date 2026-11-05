use super::*;
use axum::http::HeaderMap;

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
async fn common_error_failure_conflict_keeps_effect_fields() {
    let (status, headers, body) = failure_body(failure(
        StatusCode::CONFLICT,
        "request_conflict",
        ToolEffectState::None,
        true,
    ))
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_common_error(&headers, &body, "request_conflict", "conflict", false);
    assert_eq!(body["error"]["effect_state"], serde_json::json!("none"));
    assert_eq!(
        body["error"]["runtime_call_stopped"],
        serde_json::json!(true)
    );
    assert_eq!(body["details"]["effect_state"], serde_json::json!("none"));
    assert_eq!(
        body["details"]["runtime_call_stopped"],
        serde_json::json!(true)
    );
}

#[tokio::test]
async fn common_error_failure_outcome_unknown_keeps_legacy_retryable() {
    let (status, headers, body) = failure_body(failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "outcome_unknown",
        ToolEffectState::Unknown,
        false,
    ))
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_common_error(&headers, &body, "outcome_unknown", "internal", true);
    assert_eq!(body["error"]["effect_state"], serde_json::json!("unknown"));
    assert_eq!(
        body["error"]["runtime_call_stopped"],
        serde_json::json!(false)
    );
}

#[tokio::test]
async fn common_error_executor_failure_run_closed() {
    let (status, headers, body) = failure_body(executor_failure(ToolError::new(
        ToolErrorCode::TemporaryRunClosed,
        "temporary run is closed",
    )))
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_common_error(&headers, &body, "run_closed", "conflict", false);
}

#[tokio::test]
async fn common_error_failure_unknown_code_sanitizes() {
    let (status, headers, body) = failure_body(failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "private-canary-code",
        ToolEffectState::None,
        false,
    ))
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], serde_json::json!("internal"));
    assert_eq!(body["category"], serde_json::json!("internal"));
    assert_eq!(body["message"], serde_json::json!("Internal service error"));
    assert_eq!(body["retryable"], serde_json::json!(false));
    assert_eq!(
        body["request_id"].as_str().unwrap(),
        headers.get("x-request-id").unwrap()
    );
    assert!(body.get("error").is_none());
    assert!(body.get("details").is_none());
    assert!(!body.to_string().contains("private-canary"));
}
