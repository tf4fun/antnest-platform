mod support;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use support::schemas::assert_valid;
use tower::ServiceExt;

fn contract() -> &'static serde_json::Value {
    static CONTRACT: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/egress/control-contract.json"
        )))
        .unwrap()
    })
}

fn route_meta(method: &str, path: &str) -> &'static serde_json::Value {
    contract()["routes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|route| route["method"] == method && route["path"] == path)
        .unwrap_or_else(|| panic!("missing contract route {method} {path}"))
}

fn declared_error(method: &str, path: &str, code: &str, status: u16) {
    let listed = route_meta(method, path)["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|error| error["code"] == code && error["status"] == status);
    let shared = contract()["fallback_errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|error| error["code"] == code && error["status"] == status);
    assert!(listed || shared, "{method} {path} missing {code} {status}");
}

fn control_request(
    method: axum::http::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(path)
        .header("antnest-service-authorization", support::workload_header());
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn json_body(response: axum::response::Response) -> serde_json::Value {
    let body = to_bytes(response.into_body(), 8192).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn exchange(
    app: axum::Router,
    method: axum::http::Method,
    template: &str,
    path: &str,
    request: serde_json::Value,
) -> serde_json::Value {
    let meta = route_meta(method.as_str(), template);
    match meta["request_body"].as_str().unwrap() {
        "none" => panic!("{method} {path} accepts no request body"),
        schema => assert_valid(schema, &request),
    }
    let status: StatusCode = meta["responses"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let response = app
        .oneshot(control_request(method, path, Some(request)))
        .await
        .unwrap();
    assert_eq!(response.status(), status, "{path}");
    let body = meta["responses"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    match body["body"].as_str().unwrap() {
        "none" => {
            let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
            assert!(bytes.is_empty(), "{path}");
            serde_json::Value::Null
        }
        schema => {
            let document = json_body(response).await;
            assert_valid(schema, &document);
            document
        }
    }
}

async fn exchange_empty(
    app: axum::Router,
    method: axum::http::Method,
    template: &str,
    path: &str,
) -> serde_json::Value {
    let meta = route_meta(method.as_str(), template);
    assert_eq!(meta["request_body"], "none", "{method} {path}");
    let status: StatusCode = meta["responses"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let response = app
        .oneshot(control_request(method, path, None))
        .await
        .unwrap();
    assert_eq!(response.status(), status, "{path}");
    let body = meta["responses"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    match body["body"].as_str().unwrap() {
        "none" => {
            let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
            assert!(bytes.is_empty(), "{path}");
            serde_json::Value::Null
        }
        schema => {
            let document = json_body(response).await;
            assert_valid(schema, &document);
            document
        }
    }
}

#[tokio::test]
async fn every_route_success_matches_the_declared_body_contract() {
    let app = support::app().await;
    let agent = "contract-net";
    let network = exchange_empty(
        app.clone(),
        axum::http::Method::PUT,
        "/internal/agent-networks/{agent_id}",
        &format!("/internal/agent-networks/{agent}"),
    )
    .await;
    assert_eq!(network["agent_id"], agent);
    let inspected = exchange_empty(
        app.clone(),
        axum::http::Method::GET,
        "/internal/agent-networks/{agent_id}",
        &format!("/internal/agent-networks/{agent}"),
    )
    .await;
    assert_eq!(inspected, network);

    let service = support::service().await;
    let rc_agent = antnest_runtime_egress::domain::AgentId::parse("contract-keys").unwrap();
    let tunnel_network = service
        .ensure_agent_network(rc_agent.clone())
        .await
        .unwrap();
    let registration =
        support::auth::tunnel_registration(rc_agent.as_str(), tunnel_network.tunnel_ipv4);
    let rc_app = antnest_runtime_egress::control::router_with_capture_rpc_content(
        service.clone(),
        antnest_runtime_egress::telemetry::EgressMetrics::default(),
        support::admission_for("runtime-controller"),
        false,
    );
    let response = rc_app
        .oneshot(control_request(
            axum::http::Method::PUT,
            "/internal/agent-tunnel-keys/contract-keys",
            Some(serde_json::json!({
                "key_id": registration.key_id,
                "runtime_revision": registration.runtime_revision,
                "tunnel_ipv4": registration.tunnel_ipv4,
                "egress_private_key": registration.egress_private_key,
                "runtime_public_key": registration.runtime_public_key,
                "preshared_key": registration.preshared_key,
            })),
        ))
        .await
        .unwrap();
    let meta = route_meta("PUT", "/internal/agent-tunnel-keys/{agent_id}");
    assert_valid(
        meta["request_body"].as_str().unwrap(),
        &serde_json::json!({
            "key_id": registration.key_id,
            "runtime_revision": registration.runtime_revision,
            "tunnel_ipv4": registration.tunnel_ipv4,
            "egress_private_key": registration.egress_private_key,
            "runtime_public_key": registration.runtime_public_key,
            "preshared_key": registration.preshared_key,
        }),
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(body.is_empty());

    let shared_app = antnest_runtime_egress::control::router_with_capture_rpc_content(
        service.clone(),
        antnest_runtime_egress::telemetry::EgressMetrics::default(),
        support::admission_for("agent-controller"),
        false,
    );
    let opened = exchange(
        shared_app.clone(),
        axum::http::Method::PUT,
        "/internal/agent-network-attachments/{agent_id}",
        "/internal/agent-network-attachments/contract-keys",
        serde_json::json!({
            "state": "open",
            "expected_version": "1",
            "runtime_endpoint": "10.243.1.20",
            "tunnel_key_id": registration.key_id,
        }),
    )
    .await;
    assert_eq!(opened["attachment_state"], "open");

    let policy = serde_json::json!({"spec": {"schema_version": 1, "action": "allow_all"}});
    let metadata = exchange(
        shared_app.clone(),
        axum::http::Method::PUT,
        "/internal/policies/{policy_id}/revisions/{revision}",
        "/internal/policies/contract-policy/revisions/2",
        policy,
    )
    .await;
    assert_eq!(metadata["revision"], 2);
    let revision = exchange_empty(
        shared_app.clone(),
        axum::http::Method::GET,
        "/internal/policies/{policy_id}/revisions/{revision}",
        "/internal/policies/contract-policy/revisions/2",
    )
    .await;
    assert_eq!(revision["spec"]["action"], "allow_all");
    assert_eq!(revision["digest"], metadata["digest"]);

    let assigned = exchange(
        shared_app.clone(),
        axum::http::Method::PUT,
        "/internal/agent-policy-assignments/{agent_id}",
        "/internal/agent-policy-assignments/contract-keys",
        serde_json::json!({
            "policy_id": "contract-policy",
            "revision": 2,
            "expected_version": "1",
        }),
    )
    .await;
    assert_eq!(assigned["revision"], 2);
    let current = exchange_empty(
        shared_app.clone(),
        axum::http::Method::GET,
        "/internal/agent-policy-assignments/{agent_id}",
        "/internal/agent-policy-assignments/contract-keys",
    )
    .await;
    assert_eq!(current, assigned);

    service
        .ensure_agent_network(
            antnest_runtime_egress::domain::AgentId::parse("contract-release").unwrap(),
        )
        .await
        .unwrap();
    let released = exchange(
        shared_app,
        axum::http::Method::POST,
        "/internal/agent-networks/{agent_id}/release",
        "/internal/agent-networks/contract-release/release",
        serde_json::json!({"expected_version": "1"}),
    )
    .await;
    assert_eq!(released["state"], "quarantined");

    let status = exchange_empty(
        support::health_app().await,
        axum::http::Method::GET,
        "/status",
        "/status",
    )
    .await;
    assert_eq!(status["status"], "ready");
}

async fn assert_error(
    response: axum::response::Response,
    method: &str,
    path: &str,
    code: &str,
    status: StatusCode,
) {
    assert_eq!(response.status(), status, "{method} {path} {code}");
    let document = json_body(response).await;
    assert_valid("../common/error.schema.json", &document);
    assert_eq!(document["code"], code);
    declared_error(method, path, code, status.as_u16());
}

#[tokio::test]
async fn error_responses_match_the_common_envelope_and_declared_maps() {
    let agent = "contract-errors";
    let missing_auth = support::app()
        .await
        .oneshot(
            Request::put(format!("/internal/agent-networks/{agent}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_error(
        missing_auth,
        "PUT",
        "/internal/agent-networks/{agent_id}",
        "service_unauthenticated",
        StatusCode::UNAUTHORIZED,
    )
    .await;

    let forbidden = support::app_for_caller("runtime-controller").await
        .oneshot(control_request(
            axum::http::Method::PUT,
            &format!("/internal/agent-policy-assignments/{agent}"),
            Some(serde_json::json!({"policy_id": "builtin/allow-all", "revision": 1, "expected_version": "1"})),
        ))
        .await
        .unwrap();
    assert_error(
        forbidden,
        "PUT",
        "/internal/agent-policy-assignments/{agent_id}",
        "caller_not_allowed",
        StatusCode::FORBIDDEN,
    )
    .await;

    let media = support::app()
        .await
        .oneshot(
            Request::put(format!("/internal/agent-policy-assignments/{agent}"))
                .header("antnest-service-authorization", support::workload_header())
                .header("content-type", "text/plain")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_error(
        media,
        "PUT",
        "/internal/agent-policy-assignments/{agent_id}",
        "unsupported_media_type",
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
    )
    .await;

    let malformed = support::app()
        .await
        .oneshot(
            Request::put(format!("/internal/agent-policy-assignments/{agent}"))
                .header("antnest-service-authorization", support::workload_header())
                .header("content-type", "application/json")
                .body(Body::from("{\"policy_id\":"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_error(
        malformed,
        "PUT",
        "/internal/agent-policy-assignments/{agent_id}",
        "invalid_request",
        StatusCode::BAD_REQUEST,
    )
    .await;

    let oversized = support::app()
        .await
        .oneshot(
            Request::put(format!("/internal/agent-network-attachments/{agent}"))
                .header("antnest-service-authorization", support::workload_header())
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    "{{\"state\":\"closed\",\"pad\":\"{}\"}}",
                    "x".repeat(4096)
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_error(
        oversized,
        "PUT",
        "/internal/agent-network-attachments/{agent_id}",
        "invalid_request",
        StatusCode::PAYLOAD_TOO_LARGE,
    )
    .await;

    let missing = support::app()
        .await
        .oneshot(control_request(
            axum::http::Method::GET,
            "/internal/agent-networks/never-created",
            None,
        ))
        .await
        .unwrap();
    assert_error(
        missing,
        "GET",
        "/internal/agent-networks/{agent_id}",
        "agent_network_not_found",
        StatusCode::NOT_FOUND,
    )
    .await;

    let unmatched = support::app()
        .await
        .oneshot(control_request(
            axum::http::Method::GET,
            "/internal/not-a-route",
            None,
        ))
        .await
        .unwrap();
    assert_error(
        unmatched,
        "GET",
        "/internal/agent-networks/{agent_id}",
        "route_not_found",
        StatusCode::NOT_FOUND,
    )
    .await;

    let wrong_method = support::health_app()
        .await
        .oneshot(Request::post("/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_error(
        wrong_method,
        "GET",
        "/status",
        "method_not_allowed",
        StatusCode::METHOD_NOT_ALLOWED,
    )
    .await;

    let service = support::service().await;
    service
        .ensure_agent_network(antnest_runtime_egress::domain::AgentId::parse(agent).unwrap())
        .await
        .unwrap();
    let stale = antnest_runtime_egress::control::router_with_capture_rpc_content(
        service,
        antnest_runtime_egress::telemetry::EgressMetrics::default(),
        support::admission_for("agent-controller"),
        false,
    )
    .oneshot(control_request(
        axum::http::Method::POST,
        &format!("/internal/agent-networks/{agent}/release"),
        Some(serde_json::json!({"expected_version": "5"})),
    ))
    .await
    .unwrap();
    assert_error(
        stale,
        "POST",
        "/internal/agent-networks/{agent_id}/release",
        "resource_version_conflict",
        StatusCode::CONFLICT,
    )
    .await;
}

#[tokio::test]
async fn if_match_bodies_validate_against_the_body_schemas() {
    let agent = "contract-ifmatch";
    let service = support::service().await;
    service
        .ensure_agent_network(antnest_runtime_egress::domain::AgentId::parse(agent).unwrap())
        .await
        .unwrap();
    let app = antnest_runtime_egress::control::router_with_capture_rpc_content(
        service.clone(),
        antnest_runtime_egress::telemetry::EgressMetrics::default(),
        support::admission_for("agent-controller"),
        false,
    );
    let body = serde_json::json!({"state": "closed"});
    assert_valid("attachment-state-body.stored-v2.schema.json", &body);
    let request = |tag: Option<&str>, body: &serde_json::Value| {
        let mut builder = Request::put(format!("/internal/agent-network-attachments/{agent}"))
            .header("content-type", "application/json")
            .header("antnest-service-authorization", support::workload_header());
        if let Some(tag) = tag {
            builder = builder.header("if-match", tag);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    };
    let response = app
        .clone()
        .oneshot(request(Some("\"1\""), &body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app.clone().oneshot(request(None, &body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let both = serde_json::json!({"state": "closed", "expected_version": "2"});
    assert_valid("attachment-state-body.stored-v2.schema.json", &both);
    let response = app
        .clone()
        .oneshot(request(Some("\"2\""), &both))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let release_body = serde_json::json!({});
    assert_valid("resource-version-body.stored-v2.schema.json", &release_body);
    let release = |tag: Option<&str>, body: &serde_json::Value| {
        let mut builder = Request::post(format!("/internal/agent-networks/{agent}/release"))
            .header("content-type", "application/json")
            .header("antnest-service-authorization", support::workload_header());
        if let Some(tag) = tag {
            builder = builder.header("if-match", tag);
        }
        builder.body(Body::from(body.to_string())).unwrap()
    };
    let response = app
        .clone()
        .oneshot(release(None, &release_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let with_field = serde_json::json!({"expected_version": "1"});
    assert_valid("resource-version-body.stored-v2.schema.json", &with_field);
    let response = app
        .clone()
        .oneshot(release(Some("\"1\""), &with_field))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = app
        .clone()
        .oneshot(release(Some("\"1\""), &release_body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
