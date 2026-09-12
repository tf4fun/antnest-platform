mod support;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use support::app;
use tower::ServiceExt;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlContract {
    revision: u32,
    transport: String,
    trust_boundary: String,
    status_values: Vec<String>,
    builtin_policies: std::collections::BTreeMap<String, BuiltinPolicy>,
    routes: Vec<ContractRoute>,
    schemas: std::collections::BTreeMap<String, String>,
    error_codes: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ContractRoute {
    method: String,
    path: String,
    request_schema: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BuiltinPolicy {
    policy_id: String,
    revision: u64,
}

#[test]
fn machine_contract_matches_the_complete_control_surface() {
    let contract: ControlContract = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/egress/control-contract.json"
    )))
    .expect("control contract");

    assert_eq!(contract.revision, 4);
    assert_eq!(contract.transport, "json-over-http");
    assert_eq!(contract.trust_boundary, "internal-network");
    assert_eq!(contract.status_values, ["ready", "degraded"]);
    assert_eq!(
        contract.builtin_policies["deny_all"].policy_id,
        "builtin/deny-all"
    );
    assert_eq!(contract.builtin_policies["deny_all"].revision, 1);
    assert_eq!(
        contract.builtin_policies["allow_all"].policy_id,
        "builtin/allow-all"
    );
    assert_eq!(contract.builtin_policies["allow_all"].revision, 1);
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
    assert_eq!(
        contract.schemas["attachment_state_request"],
        "attachment-state-request.schema.json"
    );
    assert_eq!(
        contract.schemas["resource_version_request"],
        "resource-version-request.schema.json"
    );
    let state_routes = contract
        .routes
        .iter()
        .filter(|route| route.request_schema.is_some())
        .collect::<Vec<_>>();
    assert_eq!(state_routes.len(), 2);
    assert!(state_routes.iter().any(|route| {
        route.request_schema.as_deref() == Some("attachment-state-request.schema.json")
    }));
    assert!(state_routes.iter().any(|route| {
        route.request_schema.as_deref() == Some("resource-version-request.schema.json")
    }));

    let prose = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/egress/control-api.md"
    ));
    let documented_errors = prose
        .split_once("## Errors")
        .expect("control error section")
        .1
        .lines()
        .filter_map(|line| line.strip_prefix("| `"))
        .filter_map(|line| line.split_once('`').map(|(code, _)| code))
        .collect::<Vec<_>>();
    assert_eq!(
        documented_errors,
        contract
            .error_codes
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
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
    assert_eq!(document["network_resource_version"], 1);
    assert_eq!(document["attachment_state"], "closed");
    assert_eq!(document["attachment_resource_version"], 1);
    assert_eq!(
        document
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([
            "agent_id".to_owned(),
            "attachment_resource_version".to_owned(),
            "attachment_state".to_owned(),
            "egress_endpoint".to_owned(),
            "network_resource_version".to_owned(),
            "packet_contract_revision".to_owned(),
            "resolver_ipv4".to_owned(),
            "state".to_owned(),
            "tunnel_ipv4".to_owned(),
        ])
    );
}

#[tokio::test]
async fn attachment_endpoint_opens_with_a_versioned_cas() {
    let app = app().await;
    let ensure = app
        .clone()
        .oneshot(
            Request::put("/internal/agent-networks/agent-attachment")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ensure.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::put("/internal/agent-network-attachments/agent-attachment")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"state":"open","expected_resource_version":1}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(document["attachment_state"], "open");
    assert_eq!(document["attachment_resource_version"], 2);
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

async fn policy_document(app: &axum::Router, path: &str) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap()
}

#[tokio::test]
async fn policy_reads_expose_builtin_specs_without_creating_agent_state() {
    let app = app().await;
    let before = policy_document(&app, "/status").await;
    for (id, action) in [("allow-all", "allow_all"), ("deny-all", "deny_all")] {
        let path = format!("/internal/policies/builtin%2F{id}/revisions/1");
        let first = policy_document(&app, &path).await;
        assert_eq!(first["policy_id"], format!("builtin/{id}"));
        assert_eq!(first["revision"], 1);
        assert_eq!(
            first["spec"],
            serde_json::json!({"schema_version": 1, "action": action})
        );
        assert_eq!(first.as_object().unwrap().len(), 4);
        let digest = first["digest"].as_str().unwrap();
        assert!(digest.starts_with("sha256:") && digest.len() == 71);
        assert_eq!(policy_document(&app, &path).await, first);
    }
    assert_eq!(policy_document(&app, "/status").await, before);
    let missing = app
        .oneshot(
            Request::get("/internal/agent-networks/not-created")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_stable_error(missing, StatusCode::NOT_FOUND, "agent_network_not_found").await;
}

#[tokio::test]
async fn policy_reads_resolve_exact_revision_not_name_or_latest_content() {
    let app = app().await;
    for (revision, action) in [(1, "deny_all"), (2, "allow_all")] {
        let response = app
            .clone()
            .oneshot(
                Request::put(format!(
                    "/internal/policies/called-allow/revisions/{revision}"
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"spec": {"schema_version": 1, "action": action}})
                        .to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let written: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert!(
            written.get("spec").is_none(),
            "PUT metadata contract changed"
        );
        let read = policy_document(
            &app,
            &format!("/internal/policies/called-allow/revisions/{revision}"),
        )
        .await;
        assert_eq!(read["digest"], written["digest"]);
        assert_eq!(read["spec"]["action"], action);
    }
    let old = policy_document(&app, "/internal/policies/called-allow/revisions/1").await;
    assert_eq!(old["spec"]["action"], "deny_all");
    let conflict = app
        .clone()
        .oneshot(
            Request::put("/internal/policies/called-allow/revisions/1")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"spec":{"schema_version":1,"action":"allow_all"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_stable_error(conflict, StatusCode::CONFLICT, "policy_revision_conflict").await;
    assert_eq!(
        policy_document(&app, "/internal/policies/called-allow/revisions/1").await,
        old
    );
}

#[tokio::test]
async fn policy_read_errors_do_not_create_or_guess_revisions() {
    let app = app().await;
    for (path, status, code) in [
        (
            "%FF/revisions/1",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "builtin%2Fallow-all/revisions/%FF",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "missing/revisions/1",
            StatusCode::NOT_FOUND,
            "policy_revision_not_found",
        ),
        (
            "builtin%2Fallow-all/revisions/2",
            StatusCode::NOT_FOUND,
            "policy_revision_not_found",
        ),
        (
            "builtin%2Fallow-all/revisions/0",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "builtin%2Fallow-all/revisions/-1",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "builtin%2Fallow-all/revisions/no",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "builtin%2Fallow-all/revisions/18446744073709551616",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "%20/revisions/1",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/internal/policies/{path}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_stable_error(response, status, code).await;
    }
}

async fn assert_stable_invalid_request(response: axum::response::Response) {
    assert_stable_error(response, StatusCode::BAD_REQUEST, "invalid_request").await;
}

async fn assert_stable_error(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["content-type"], "application/json");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(document["code"], code);
    assert_eq!(document["retryable"], false);
}
