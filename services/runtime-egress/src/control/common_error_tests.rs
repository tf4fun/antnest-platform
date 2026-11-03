use super::*;
use axum::http::HeaderMap;

async fn failure_body(response: Response) -> (StatusCode, HeaderMap, serde_json::Value, Response) {
    let status = response.status();
    let headers = response.headers().clone();
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("failure body");
    let value: serde_json::Value = serde_json::from_slice(&bytes).expect("failure body is JSON");
    (
        status,
        headers,
        value,
        Response::from_parts(parts, Body::empty()),
    )
}

fn assert_common_error(
    status: StatusCode,
    headers: &HeaderMap,
    body: &serde_json::Value,
    expected: (StatusCode, &str, &str, &str, bool),
) {
    let (want_status, code, category, message, retryable) = expected;
    assert_eq!(status, want_status);
    let request_id = headers
        .get("x-request-id")
        .expect("x-request-id header")
        .to_str()
        .expect("ascii request id");
    assert!(!request_id.is_empty() && request_id.len() <= 128);
    assert!(request_id.chars().all(|c| c.is_ascii_alphanumeric()
        || c == '.'
        || c == '_'
        || c == ':'
        || c == '-'));
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    for key in ["code", "category", "message", "retryable", "request_id"] {
        assert!(body.get(key).is_some(), "missing {}", key);
    }
    assert_eq!(body["code"], serde_json::json!(code));
    assert_eq!(body["category"], serde_json::json!(category));
    assert_eq!(body["message"], serde_json::json!(message));
    assert_eq!(body["retryable"], serde_json::json!(retryable));
    assert_eq!(body["request_id"], serde_json::json!(request_id));
    assert!(!body.to_string().contains("private-canary"));
}

#[tokio::test]
async fn common_error_from_invalid_request() {
    let (status, headers, body, _) =
        failure_body(ApiError::from(ControlError::InvalidRequest).into_response()).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "invalid_request",
            "request validation failed",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_from_policy_revision_conflict() {
    let (status, headers, body, _) =
        failure_body(ApiError::from(ControlError::PolicyRevisionConflict).into_response()).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::CONFLICT,
            "policy_revision_conflict",
            "conflict",
            "policy revision key has different content",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_from_address_pool_exhausted() {
    let (status, headers, body, _) =
        failure_body(ApiError::from(ControlError::AddressPoolExhausted).into_response()).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::CONFLICT,
            "address_pool_exhausted",
            "conflict",
            "address pool is exhausted",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_from_agent_network_not_found() {
    let (status, headers, body, _) =
        failure_body(ApiError::from(ControlError::AgentNetworkNotFound).into_response()).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::NOT_FOUND,
            "agent_network_not_found",
            "not_found",
            "Agent network was not found",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_operation_failed_keeps_legacy_retry() {
    let (status, headers, body, _) = failure_body(
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "operation_failed",
            "control operation did not complete",
            true,
        )
        .into_response(),
    )
    .await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "operation_failed",
            "internal",
            "control operation did not complete",
            true,
        ),
    );
}

#[tokio::test]
async fn common_error_unauthenticated_keeps_challenge() {
    let response = ApiError::new(
        StatusCode::UNAUTHORIZED,
        "service_unauthenticated",
        "service authentication failed",
        false,
    )
    .into_response();
    assert_eq!(
        response.headers().get("www-authenticate").unwrap(),
        "Bearer realm=\"antnest-service\""
    );
    let (status, headers, body, _) = failure_body(response).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::UNAUTHORIZED,
            "service_unauthenticated",
            "unauthenticated",
            "service authentication failed",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_unknown_code_sanitizes() {
    let (status, headers, body, extension) = failure_body(
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ghost_code",
            "private-canary",
            true,
        )
        .into_response(),
    )
    .await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal",
            "Internal service error",
            false,
        ),
    );
    assert_eq!(
        extension.extensions().get::<ControlErrorCode>(),
        Some(&ControlErrorCode("internal"))
    );
    let failure = extension
        .extensions()
        .get::<SafeFailure>()
        .expect("safe failure");
    assert_eq!(failure.code, "internal");
    assert_eq!(failure.message, "Internal service error");
}

#[test]
fn common_error_control_code_catalog_parity() {
    for code in crate::control::CONTROL_ERROR_CODES {
        assert!(
            crate::api_errors_gen::metadata(code).is_some(),
            "control error code {} is not registered",
            code
        );
    }
}

#[test]
fn common_error_generated_request_id_safety() {
    let envelope = crate::api_errors_gen::envelope(
        crate::api_errors_gen::INVALID_REQUEST,
        "probe",
        "request-42.safe",
        false,
    );
    assert_eq!(envelope["request_id"], serde_json::json!("request-42.safe"));
    let envelope = crate::api_errors_gen::envelope(
        crate::api_errors_gen::INVALID_REQUEST,
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
    let scan = |source: &str| -> usize {
        let mut problems = 0;
        for token in ["ApiError::new(", "Self::new(", "code: "] {
            let mut offset = 0usize;
            while let Some(position) = source[offset..].find(token) {
                let start = offset + position;
                if token == "code: " {
                    let before = source.as_bytes().get(start.wrapping_sub(1)).copied();
                    if matches!(before, Some(b) if b.is_ascii_alphanumeric() || b == b'_') {
                        offset = start + token.len();
                        continue;
                    }
                }
                let rest = &source[start + token.len()..];
                let candidate = if token == "code: " {
                    rest
                } else {
                    match rest.find(',') {
                        Some(comma) => &rest[comma + 1..],
                        None => rest,
                    }
                };
                if candidate.trim_start().starts_with('"') {
                    problems += 1;
                }
                offset = start + token.len();
            }
        }
        problems
    };
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let source = std::fs::read_to_string(manifest.join("control.rs")).expect("control.rs");
    assert_eq!(
        scan(&source),
        0,
        "control.rs still has literal producer codes"
    );
    assert_eq!(
        scan(
            "ApiError::new(
    StatusCode::CONFLICT,
    \"request_conflict\",
    \"message\",
    false,
)"
        ),
        1
    );
    assert_eq!(
        scan("Self::new(StatusCode::BAD_REQUEST, \"invalid_request\", \"m\", false)"),
        1
    );
    assert_eq!(scan("code: \"cleanup_failed\""), 1);
    assert_eq!(
        scan(
            "ApiError::new(StatusCode::BAD_REQUEST, crate::api_errors_gen::INVALID_REQUEST, \"m\", false)"
        ),
        0
    );
}
