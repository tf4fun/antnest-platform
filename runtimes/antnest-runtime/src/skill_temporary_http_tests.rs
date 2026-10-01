use crate::mcp::RuntimeStatus;
use crate::skill_maintenance_auth_tests::{fixture, signed};
use crate::skill_temporary_http::temporary_skill_router;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt as _;

#[tokio::test]
async fn temporary_body_receive_is_bounded_before_executor_dispatch() {
    use crate::skill_temporary_http::receive_temporary_body;
    use std::time::Duration;
    let stalled = Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >());
    assert_eq!(
        receive_temporary_body(stalled, 4, Duration::from_millis(5))
            .await
            .unwrap_err(),
        "body_timed_out"
    );
    assert_eq!(
        receive_temporary_body(Body::from("12345"), 4, Duration::from_secs(1))
            .await
            .unwrap_err(),
        "body_too_large"
    );
    assert_eq!(
        receive_temporary_body(Body::from("1234"), 4, Duration::from_secs(1))
            .await
            .unwrap(),
        "1234"
    );
}

#[tokio::test]
async fn temporary_http_is_disabled_without_bootstrap_and_unknown_actions_stay_hidden() {
    let (_, identity, _) = fixture();
    let status = RuntimeStatus::with_execution_id(identity, "execution-1");
    for (action, expected, code) in [
        ("release", StatusCode::FORBIDDEN, "temporary_disabled"),
        ("promote", StatusCode::NOT_FOUND, "unknown_action"),
    ] {
        let response = temporary_skill_router(status.clone(), vec![], None)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/internal/skill-temporary/{action}"))
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(value["error"]["code"], code);
        assert_eq!(value["error"]["effect_state"], "none");
        assert_eq!(value["error"]["runtime_call_stopped"], true);
    }
}

#[tokio::test]
async fn temporary_http_requires_its_own_signed_action_and_current_execution_and_body() {
    let (pair, identity, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(identity, "execution-1");
    let body=serde_json::to_vec(&json!({"action":"temporary_release","request_id":"request-1","job_id":"run-1","generation":1})).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    for (action, execution, actual_body, expected) in [
        (
            "temporary_release",
            "execution-1",
            body.as_slice(),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            "release",
            "execution-1",
            body.as_slice(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "temporary_release",
            "old-execution",
            body.as_slice(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "temporary_release",
            "execution-1",
            b"changed".as_slice(),
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let token = signed(&pair, &body, |payload| {
            payload["action"] = json!(action);
            payload["execution_id"] = json!(execution);
            payload["job_id"] = json!("run-1");
            payload["issued_at"] = json!(now);
            payload["expires_at"] = json!(now + 60);
        });
        let response = temporary_skill_router(status.clone(), keys.clone(), None)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/skill-temporary/release")
                    .header("Authorization", token)
                    .header("Content-Type", "application/json")
                    .body(Body::from(actual_body.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(value["error"]["effect_state"], "none");
        assert_eq!(
            value["error"]["message"],
            "Temporary Skill request did not complete"
        );
        assert!(!value.to_string().contains("AntnestMaintenance"));
    }
}
