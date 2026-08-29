use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlService, KernelCleanup},
    control::router,
    repository::{InMemoryRepository, RepositoryConfig},
    telemetry::EgressMetrics,
};
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlContract {
    revision: u32,
    transport: String,
    trust_boundary: String,
    status_values: Vec<String>,
    routes: Vec<ContractRoute>,
    schemas: std::collections::BTreeMap<String, String>,
    error_codes: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ContractRoute {
    method: String,
    path: String,
}

struct NoopKernel;

#[async_trait]
impl KernelCleanup for NoopKernel {
    async fn clear_agent(&self, _: Ipv4Addr) -> Result<(), String> {
        Ok(())
    }
}

async fn app() -> axum::Router {
    let repository = InMemoryRepository::new(RepositoryConfig {
        pool_id: "default".to_owned(),
        tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
        resolver_ipv4: "100.64.0.1".parse().unwrap(),
        quarantine: Duration::from_secs(300),
    })
    .unwrap();
    let service = ControlService::new(
        Arc::new(repository),
        Arc::new(NoopKernel),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    );
    let service = Arc::new(service);
    service.recover().await.unwrap();
    router(service, EgressMetrics::default())
}

#[test]
fn machine_contract_matches_the_complete_control_surface() {
    let contract: ControlContract = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/egress/control-contract.json"
    )))
    .expect("control contract");

    assert_eq!(contract.revision, 1);
    assert_eq!(contract.transport, "json-over-http");
    assert_eq!(contract.trust_boundary, "internal-network");
    assert_eq!(contract.status_values, ["ready", "degraded"]);
    assert_eq!(
        contract
            .routes
            .iter()
            .map(|route| (route.method.as_str(), route.path.as_str()))
            .collect::<Vec<_>>(),
        antnest_runtime_egress::control::CONTROL_ROUTES
    );
    assert_eq!(
        contract.error_codes,
        antnest_runtime_egress::control::CONTROL_ERROR_CODES
    );
    assert_eq!(contract.schemas["policy"], "policy.schema.json");
    assert_eq!(
        contract.schemas["packet"],
        "../runtime/packet-contract.json"
    );
}

#[tokio::test]
async fn status_exposes_data_and_control_readiness() {
    let response = app()
        .await
        .oneshot(Request::get("/status").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(document["status"], "ready");
    assert_eq!(document["data_plane_ready"], true);
    assert_eq!(document["control_plane_ready"], true);
    assert_eq!(document["snapshot_revision"], 1);
}

#[tokio::test]
async fn ensure_endpoint_returns_runtime_attachment() {
    let response = app()
        .await
        .oneshot(
            Request::put("/internal/agent-networks/agent-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(document["agent_id"], "agent-1");
    assert_eq!(document["tunnel_ipv4"], "100.64.0.2");
    assert_eq!(document["packet_contract_revision"], 1);
    assert_eq!(document["egress_endpoint"]["ipv4"], "10.20.0.8");
    assert_eq!(document["egress_endpoint"]["port"], 8092);
    assert_eq!(
        document
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([
            "agent_id".to_owned(),
            "egress_endpoint".to_owned(),
            "packet_contract_revision".to_owned(),
            "resolver_ipv4".to_owned(),
            "state".to_owned(),
            "tunnel_ipv4".to_owned(),
        ])
    );
}

#[tokio::test]
async fn unknown_routes_and_methods_use_the_stable_error_shape() {
    let missing = app()
        .await
        .oneshot(
            Request::get("/internal/missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_stable_error(missing, StatusCode::NOT_FOUND, "route_not_found").await;

    let method = app()
        .await
        .oneshot(
            Request::post("/internal/agent-networks/agent-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_stable_error(method, StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed").await;
}

#[tokio::test]
async fn malformed_identifiers_use_the_stable_error_shape() {
    let response = app()
        .await
        .oneshot(
            Request::put("/internal/agent-networks/%20")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(document["code"], "invalid_request");
    assert_eq!(document["retryable"], false);
}

#[tokio::test]
async fn malformed_path_numbers_use_the_stable_error_shape() {
    let response = app()
        .await
        .oneshot(
            Request::put("/internal/policies/internet/revisions/not-a-number")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"spec":{"schema_version":1,"action":"allow_all"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_stable_invalid_request(response).await;
}

async fn assert_stable_invalid_request(response: axum::response::Response) {
    assert_stable_error(response, StatusCode::BAD_REQUEST, "invalid_request").await;
}

async fn assert_stable_error(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(document["code"], code);
    assert_eq!(document["retryable"], false);
}
