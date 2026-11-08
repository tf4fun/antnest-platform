mod support;

use antnest_runtime_egress::domain::{AgentId, PolicyId};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use support::app;
use tower::ServiceExt;

const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/common/id-vectors.json"
));

#[test]
fn agent_id_matches_shared_vectors() {
    let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let agent = &vectors["agentId"];
    for value in agent["accept"].as_array().unwrap() {
        let value = value.as_str().unwrap();
        let parsed = AgentId::parse(value).unwrap_or_else(|err| panic!("accept {value:?}: {err}"));
        assert_eq!(parsed.as_str(), value);
        let serialized = serde_json::to_string(&parsed).unwrap();
        assert_eq!(
            serde_json::from_str::<AgentId>(&serialized).unwrap(),
            parsed
        );
    }
    for value in agent["reject"].as_array().unwrap() {
        let value = value.as_str().unwrap();
        assert!(AgentId::parse(value).is_err(), "reject {value:?}");
        let serialized = serde_json::to_string(value).unwrap();
        assert!(
            serde_json::from_str::<AgentId>(&serialized).is_err(),
            "serde reject {value:?}"
        );
    }
}

#[test]
fn policy_id_keeps_independent_rules() {
    assert!(PolicyId::parse("builtin/deny-all").is_ok());
    assert!(PolicyId::parse("policy:legacy").is_ok());
    assert!(PolicyId::parse("a".repeat(255)).is_ok());
}

async fn agent_request(
    application: axum::Router,
    method: &str,
    path: &str,
) -> (StatusCode, serde_json::Value) {
    let response = application
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("antnest-service-authorization", support::workload_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let document: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    (status, document)
}

#[tokio::test]
async fn resource_id_control_admission() {
    let application = app().await;
    for (path, decoded) in [
        (
            format!("/internal/agent-networks/{}", "a".repeat(200)),
            "a".repeat(200),
        ),
        (
            "/internal/agent-networks/agent-1".to_string(),
            "agent-1".to_string(),
        ),
        (
            "/internal/agent-networks/Legacy.Agent_9".to_string(),
            "Legacy.Agent_9".to_string(),
        ),
    ] {
        let (status, document) = agent_request(application.clone(), "PUT", &path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(document["agent_id"], decoded, "{path}");
        let (status, document) = agent_request(application.clone(), "GET", &path).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(document["agent_id"], decoded, "{path}");
    }
    for (path, code) in [
        (
            format!("/internal/agent-networks/{}", "a".repeat(201)),
            "invalid_request",
        ),
        (
            "/internal/agent-networks/agent%2Fembedded".to_string(),
            "invalid_request",
        ),
        (
            "/internal/agent-networks/agent%3Aembedded".to_string(),
            "invalid_request",
        ),
        (
            "/internal/agent-networks/%5Fleading".to_string(),
            "invalid_request",
        ),
    ] {
        let (status, document) = agent_request(application.clone(), "PUT", &path).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "{path} rejected with {status}",
        );
        assert_eq!(document["code"], code, "{path}");
        let (status, document) = agent_request(application.clone(), "GET", &path).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "{path} lookup exposed a resource with {status}",
        );
        assert_eq!(document["code"], code, "{path} lookup leaked a resource");
    }
}
