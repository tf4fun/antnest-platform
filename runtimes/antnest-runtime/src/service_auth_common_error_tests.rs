use super::*;
use axum::http::{HeaderMap, StatusCode};

async fn failure_body(
    response: axum::response::Response,
) -> (StatusCode, HeaderMap, serde_json::Value) {
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
    assert_eq!(body["code"], serde_json::json!(code));
    assert_eq!(body["category"], serde_json::json!(category));
    assert_eq!(body["message"], serde_json::json!(message));
    assert_eq!(body["retryable"], serde_json::json!(retryable));
    assert_eq!(body["request_id"], serde_json::json!(request_id));
    assert!(!body.to_string().contains("private-canary"));
}

#[tokio::test]
async fn common_error_rejection_unauthorized() {
    let response = rejection(StatusCode::UNAUTHORIZED, "runtime_unauthorized");
    assert_eq!(
        response.headers().get("www-authenticate").unwrap(),
        "Bearer realm=\"antnest-service\""
    );
    let (status, headers, body) = failure_body(response).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::UNAUTHORIZED,
            "runtime_unauthorized",
            "unauthenticated",
            "Runtime request rejected",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_rejection_forbidden() {
    let (status, headers, body) =
        failure_body(rejection(StatusCode::FORBIDDEN, "host_not_allowed")).await;
    assert_common_error(
        status,
        &headers,
        &body,
        (
            StatusCode::FORBIDDEN,
            "host_not_allowed",
            "forbidden",
            "Runtime request rejected",
            false,
        ),
    );
}

#[tokio::test]
async fn common_error_rejection_unknown_code_sanitizes() {
    let (status, headers, body) =
        failure_body(rejection(StatusCode::INTERNAL_SERVER_ERROR, "ghost_code")).await;
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
}
