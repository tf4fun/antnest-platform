#[path = "../../../services/runtime-egress/tests/support/mod.rs"]
mod support;

use antnest_runtime_egress::{
    control::router_with_capture_rpc_content, domain::AgentId, telemetry::EgressMetrics,
};
use axum::{body::Body, http::Request};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tower::ServiceExt as _;

const FIXTURE: &str = include_str!("policy-v2-handoff.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

async fn call(
    router: &axum::Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("antnest-service-authorization", support::workload_header());
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
        .body(match body {
            Some(value) => Body::from(serde_json::to_vec(&value).unwrap()),
            None => Body::empty(),
        })
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn v2_handoff_fixture_drives_real_publish_and_assignment() {
    let fixture = fixture();
    let service = support::service().await;
    let agent = AgentId::parse(fixture["agent_id"].as_str().unwrap()).unwrap();
    service.ensure_agent_network(agent).await.unwrap();
    let router = router_with_capture_rpc_content(
        service.clone(),
        EgressMetrics::default(),
        support::admission_for("agent-controller"),
        false,
    );

    let escaped = fixture["policy_id"].as_str().unwrap().replace('/', "%2F");
    let revision_path = format!("/internal/policies/{escaped}/revisions/1");
    let publish = json!({ "spec": fixture["spec"] });

    let (status, body) = call(&router, "PUT", &revision_path, Some(publish.clone())).await;
    assert_eq!(status, 200);
    assert_eq!(
        body, fixture["egress_put_ack"],
        "PUT ack must be metadata-only"
    );
    assert_eq!(body.as_object().unwrap().len(), 4);
    assert!(body.get("spec").is_none());

    let (status, body) = call(&router, "PUT", &revision_path, Some(publish.clone())).await;
    assert_eq!(status, 200, "immutable retry must return the same ack");
    assert_eq!(body, fixture["egress_put_ack"]);

    let mut changed = publish.clone();
    changed["spec"]["default"] = json!("allow");
    let (status, body) = call(&router, "PUT", &revision_path, Some(changed)).await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], json!("policy_revision_conflict"));

    let (status, body) = call(&router, "GET", &revision_path, None).await;
    assert_eq!(status, 200);
    assert_eq!(
        body["spec"], fixture["spec"],
        "GET detail returns the full spec"
    );
    assert_eq!(body["digest"], fixture["egress_put_ack"]["digest"]);

    let assignment_path = format!(
        "/internal/agent-policy-assignments/{}",
        fixture["agent_id"].as_str().unwrap()
    );
    let cas = json!({
        "policy_id": fixture["policy_id"],
        "revision": 1,
        "expected_resource_version": fixture["expected_resource_version"],
    });
    let (status, body) = call(&router, "PUT", &assignment_path, Some(cas.clone())).await;
    assert_eq!(status, 200);
    assert_eq!(body, fixture["assignment"]);

    let (status, body) = call(&router, "PUT", &assignment_path, Some(cas)).await;
    assert_eq!(
        status, 200,
        "replaying the original CAS tuple stays idempotent"
    );
    assert_eq!(body, fixture["assignment"]);
}
