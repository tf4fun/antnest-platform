mod support;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tower::ServiceExt as _;

const ROUTES: [(&str, &str); 10] = [
    ("GET", "/internal/agent-networks/agent-admission"),
    ("PUT", "/internal/agent-networks/agent-admission"),
    ("PUT", "/internal/agent-network-attachments/agent-admission"),
    ("POST", "/internal/agent-networks/agent-admission/release"),
    ("PUT", "/internal/policies/probe/revisions/1"),
    ("GET", "/internal/policies/probe/revisions/1"),
    ("GET", "/internal/agent-policy-assignments/agent-admission"),
    ("PUT", "/internal/agent-policy-assignments/agent-admission"),
    ("GET", "/internal/unlisted"),
    ("DELETE", "/internal/agent-networks/%20"),
];

async fn error(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(
        response
            .headers()
            .get_all("www-authenticate")
            .iter()
            .count(),
        usize::from(status == StatusCode::UNAUTHORIZED)
    );
    if status == StatusCode::UNAUTHORIZED {
        assert_eq!(
            response.headers()["www-authenticate"],
            "Bearer realm=\"antnest-service\""
        );
    }
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(document["code"], code);
    assert_eq!(document["retryable"], false);
    assert_eq!(document.as_object().unwrap().len(), 3);
    assert!(
        !String::from_utf8(bytes.to_vec())
            .unwrap()
            .contains(support::workload_token())
    );
}

#[tokio::test]
async fn every_route_and_fallback_authenticates_before_body_path_or_query() {
    let app = support::app().await;
    for (method, path) in ROUTES {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("{path}?actor=forged"))
                    .header("content-type", "text/plain")
                    .header("authorization", support::workload_header())
                    .header("x-antnest-service", "agent-controller")
                    .header("x-antnest-role", "admin")
                    .body(Body::from("not JSON"))
                    .unwrap(),
            )
            .await
            .unwrap();
        error(
            response,
            StatusCode::UNAUTHORIZED,
            "service_unauthenticated",
        )
        .await;
    }
}

#[tokio::test]
async fn ambiguous_and_malformed_workload_headers_are_never_admitted() {
    let app = support::app().await;
    for values in [
        vec![String::new()],
        vec![support::workload_header(), support::workload_header()],
        vec![format!(
            "{}, {}",
            support::workload_header(),
            support::workload_header()
        )],
        vec![format!("Bearer  {}", support::workload_token())],
        vec![format!("Bearer {}=", support::workload_token())],
        vec![format!("Bearer\t{}", support::workload_token())],
        vec!["Bearer unrecognized".to_owned()],
    ] {
        let mut request = Request::put("/internal/agent-networks/agent-malformed");
        for value in values {
            request = request.header("antnest-service-authorization", value);
        }
        error(
            app.clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap(),
            StatusCode::UNAUTHORIZED,
            "service_unauthenticated",
        )
        .await;
    }
}

#[tokio::test]
async fn denied_ensure_cannot_consume_an_address_or_create_a_receipt() {
    let app = support::app().await;
    let _ = app
        .clone()
        .oneshot(
            Request::put("/internal/agent-networks/denied")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let response = app
        .oneshot(
            Request::put("/internal/agent-networks/accepted")
                .header("antnest-service-authorization", support::workload_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(document["tunnel_ipv4"], "100.64.0.2");
    assert_eq!(document["network_resource_version"], 1);
}

#[tokio::test]
async fn known_business_routes_reject_queries_and_no_body_routes_reject_bodies() {
    let app = support::app().await;
    for (method, path) in ROUTES.into_iter().take(8) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("{path}?ignored=1"))
                    .header("antnest-service-authorization", support::workload_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        error(response, StatusCode::BAD_REQUEST, "invalid_request").await;
    }
    for (method, path) in [ROUTES[0], ROUTES[1], ROUTES[5], ROUTES[6]] {
        error(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("antnest-service-authorization", support::workload_header())
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        )
        .await;
    }
}

#[tokio::test]
async fn media_errors_are_415_for_each_json_route_before_decoding() {
    let app = support::app().await;
    for (method, path) in [ROUTES[2], ROUTES[3], ROUTES[4], ROUTES[7]] {
        for content_types in [
            vec![],
            vec!["text/plain"],
            vec!["application/json; charset=latin1"],
            vec!["application/json; charset=utf-8; charset=utf-8"],
            vec!["application/json", "application/json"],
        ] {
            let mut request = Request::builder()
                .method(method)
                .uri(path)
                .header("antnest-service-authorization", support::workload_header());
            for value in content_types {
                request = request.header("content-type", value);
            }
            error(
                app.clone()
                    .oneshot(request.body(Body::from("malformed")).unwrap())
                    .await
                    .unwrap(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
            )
            .await;
        }
        error(
            app.clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("antnest-service-authorization", support::workload_header())
                        .header("content-type", "application/json")
                        .header("content-encoding", "gzip")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        )
        .await;
    }
}

#[tokio::test]
async fn strict_json_and_size_rejections_have_no_policy_effects() {
    let app = support::app().await;
    for bytes in [
        br#"{"spec":{"action":"deny_all"},"spec":{"action":"allow_all"}}"#.to_vec(),
        br#"{"spec":{"action":"deny_all","\u0061ction":"allow_all"}}"#.to_vec(),
        br#"{"spec":{"action":"allow_all"},"extra":true}"#.to_vec(),
        b"\xef\xbb\xbf{\"spec\":{\"action\":\"allow_all\"}}".to_vec(),
        b"{\"spec\":\"\xff\"}".to_vec(),
        b"[]".to_vec(),
        b"{} {}".to_vec(),
    ] {
        error(
            app.clone()
                .oneshot(
                    Request::put("/internal/policies/strict/revisions/1")
                        .header("antnest-service-authorization", support::workload_header())
                        .header("content-type", "application/json")
                        .body(Body::from(bytes))
                        .unwrap(),
                )
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        )
        .await;
    }
    error(
        app.clone()
            .oneshot(
                Request::put("/internal/policies/strict/revisions/1")
                    .header("antnest-service-authorization", support::workload_header())
                    .header("content-type", "application/json")
                    .body(Body::from(vec![b' '; 4097]))
                    .unwrap(),
            )
            .await
            .unwrap(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "invalid_request",
    )
    .await;
    let response = app
        .oneshot(
            Request::get("/internal/policies/strict/revisions/1")
                .header("antnest-service-authorization", support::workload_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn control_listener_never_exposes_anonymous_status() {
    let app = support::app().await;
    error(
        app.clone()
            .oneshot(Request::get("/status").body(Body::empty()).unwrap())
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED,
        "service_unauthenticated",
    )
    .await;
    error(
        app.oneshot(
            Request::get("/status")
                .header("antnest-service-authorization", support::workload_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
        StatusCode::NOT_FOUND,
        "route_not_found",
    )
    .await;
}

#[tokio::test]
async fn known_other_workloads_are_forbidden_on_all_routes_before_validation() {
    for caller in [
        "runtime-controller",
        "agent-acp-service",
        "antnest-runtime",
        "skill-registry",
        "admin-console",
    ] {
        let app = support::app_for_caller(caller).await;
        for (method, path) in ROUTES {
            error(
                app.clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(format!("{path}?forged=1"))
                            .header("antnest-service-authorization", support::workload_header())
                            .header("x-antnest-service", "agent-controller")
                            .body(Body::from("invalid"))
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
                StatusCode::FORBIDDEN,
                "caller_not_allowed",
            )
            .await;
        }
    }
}

#[tokio::test]
async fn implicit_head_cannot_add_a_business_method_outside_the_contract() {
    let app = support::app().await;
    for (_, path) in [ROUTES[0], ROUTES[5], ROUTES[6]] {
        let response = app
            .clone()
            .oneshot(
                Request::head(path)
                    .header("antnest-service-authorization", support::workload_header())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}

#[tokio::test]
async fn health_router_only_serves_exact_get_and_head_status() {
    let app = support::health_app().await;
    for method in ["GET", "HEAD"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        if method == "HEAD" {
            assert!(bytes.is_empty());
        } else {
            let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(document.as_object().unwrap().len(), 4);
            assert_eq!(document["status"], "ready");
        }
    }
    for (method, path, body, expected) in [
        ("PUT", ROUTES[1].1, "", StatusCode::NOT_FOUND),
        ("POST", "/status", "", StatusCode::METHOD_NOT_ALLOWED),
        ("GET", "/status?ignored=1", "", StatusCode::BAD_REQUEST),
        ("GET", "/status", "{}", StatusCode::BAD_REQUEST),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}
