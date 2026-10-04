mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[tokio::test]
async fn unsigned_identity_hints_cannot_allocate_an_agent_network() {
    let response = support::app()
        .await
        .oneshot(
            Request::put("/internal/agent-networks/agent-auth-regression")
                .header("x-antnest-role", "admin")
                .header("x-antnest-principal-id", "forged-owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers().get("www-authenticate").unwrap(),
        "Bearer realm=\"antnest-service\""
    );
}

#[tokio::test]
async fn json_media_rejection_keeps_415_at_the_control_boundary() {
    let response = support::app()
        .await
        .oneshot(
            Request::put("/internal/policies/auth-regression/revisions/1")
                .header("antnest-service-authorization", support::workload_header())
                .header("content-type", "text/plain")
                .body(Body::from(
                    r#"{"spec":{"schema_version":1,"action":"allow_all"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
}
