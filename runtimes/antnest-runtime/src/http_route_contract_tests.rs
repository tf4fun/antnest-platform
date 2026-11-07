use axum::{
    Json,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::OnceLock;
use tower::ServiceExt as _;

fn documents() -> &'static [(String, Value)] {
    static DOCS: OnceLock<Vec<(String, Value)>> = OnceLock::new();
    DOCS.get_or_init(|| {
        let mut docs = Vec::new();
        for dir in ["runtime", "common"] {
            let path = format!("{}/../../contracts/{dir}", env!("CARGO_MANIFEST_DIR"));
            let mut names = std::fs::read_dir(&path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .filter(|name| name.ends_with(".schema.json"))
                .collect::<Vec<_>>();
            names.sort();
            for name in names {
                let text = std::fs::read_to_string(format!("{path}/{name}")).unwrap();
                docs.push((
                    format!("{dir}/{name}"),
                    serde_json::from_str(&text).unwrap(),
                ));
            }
        }
        docs
    })
}

fn absolute(reference: &str) -> String {
    let (file, fragment) = match reference.split_once('#') {
        Some((file, fragment)) => (file, format!("#{fragment}")),
        None => (reference, String::new()),
    };
    let joined = format!("runtime/{file}");
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            _ => parts.push(part),
        }
    }
    format!("https://schemas.antnest.dev/{}{fragment}", parts.join("/"))
}

fn validator(reference: &str) -> jsonschema::Validator {
    let mut options = jsonschema::options();
    for (_key, document) in documents() {
        let id = document["$id"].as_str().unwrap().to_owned();
        options = options.with_resource(
            id,
            jsonschema::Resource::from_contents(document.clone()).unwrap(),
        );
    }
    options
        .build(&json!({"$ref": absolute(reference)}))
        .unwrap()
}

pub(crate) fn assert_valid(reference: &str, document: &Value) {
    if let Err(error) = validator(reference).validate(document) {
        panic!("{reference} rejected {document}: {error}");
    }
}

fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/runtime/contract.json"
        )))
        .unwrap()
    })
}

fn callers() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/runtime/callers.json"
        )))
        .unwrap()
    })
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn declare_error(method: &str, path: &str, code: &str, status: StatusCode) {
    let route = contract()["routes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|route| route["method"] == method && route["path"] == path)
        .unwrap_or_else(|| panic!("missing contract route {method} {path}"));
    assert!(
        route["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| { error["code"] == code && error["status"] == status.as_u16() }),
        "{method} {path} does not declare {code} {status}"
    );
}

#[test]
fn contract_routes_match_the_inventory_and_caller_catalog() {
    let mut declared = contract()["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|route| {
            format!(
                "{} {}",
                route["method"].as_str().unwrap(),
                route["path"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>();
    declared.sort();
    let mut inventory = crate::mcp::HTTP_ROUTES
        .iter()
        .map(|(method, path)| format!("{method} {path}"))
        .collect::<Vec<_>>();
    inventory.sort();
    assert_eq!(declared, inventory);
    let mut catalog = callers()["routes"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    catalog.sort();
    assert_eq!(declared, catalog);
    for route in contract()["routes"].as_array().unwrap() {
        assert_eq!(route["error_schema"], "../common/error.schema.json");
    }
}

#[tokio::test]
async fn status_handlers_emit_schema_valid_bodies() {
    use crate::managed_mcp::catalog::Catalog;
    use crate::mcp::{RuntimeStatus, live_status, status_response};
    use crate::spec::RuntimeIdentity;

    let catalog = Catalog::default();
    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 2).unwrap(),
        "execution-1",
    );
    let (code, Json(body)) = status_response(status, catalog.clone()).await;
    assert_eq!(code, StatusCode::OK);
    let document = serde_json::to_value(&body).unwrap();
    assert_valid("runtime-status.schema.json", &document);

    let (code, Json(live)) = live_status(catalog).await;
    assert_eq!(code, StatusCode::OK);
    assert_valid("http.schema.json#/$defs/live_status", &live);
}

#[tokio::test]
async fn maintenance_route_real_requests_validate_against_published_schemas() {
    use crate::mcp::{RuntimeStatus, skill_maintenance_router};
    use crate::skill_maintenance_auth_tests::{fixture, signed};
    use crate::skill_maintenance_request_tests::{prepared_body, prepared_zip};
    use std::time::{SystemTime, UNIX_EPOCH};

    let (pair, identity, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(identity, "execution-1");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let disabled = skill_maintenance_router(status.clone(), vec![])
        .oneshot(
            Request::post("/internal/skill-maintenance/digest")
                .header("authorization", "unsigned")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(disabled.status(), StatusCode::FORBIDDEN);
    let value = body_json(disabled).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["code"], "maintenance_disabled");
    declare_error(
        "POST",
        "/internal/skill-maintenance/{action}",
        "maintenance_disabled",
        StatusCode::FORBIDDEN,
    );

    let unknown = skill_maintenance_router(status.clone(), keys.clone())
        .oneshot(
            Request::post("/internal/skill-maintenance/revert")
                .header("authorization", "unsigned")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    let value = body_json(unknown).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["code"], "unknown_action");
    declare_error(
        "POST",
        "/internal/skill-maintenance/{action}",
        "unknown_action",
        StatusCode::NOT_FOUND,
    );

    let digest = serde_json::to_vec(&json!({
        "action": "digest",
        "request_id": "request-1",
        "job_id": "job-1",
        "generation": 1,
        "package_path": ".antnest/skills/retry-timeouts",
    }))
    .unwrap();
    assert_valid(
        "skill-maintenance.schema.json#/$defs/digest_request",
        &serde_json::from_slice::<Value>(&digest).unwrap(),
    );
    let token = signed(&pair, &digest, |payload| {
        payload["action"] = json!("digest");
        payload["issued_at"] = json!(now);
        payload["expires_at"] = json!(now + 60);
    });
    let response = skill_maintenance_router(status.clone(), keys.clone())
        .oneshot(
            Request::post("/internal/skill-maintenance/digest")
                .header("authorization", token)
                .header("content-type", "application/json")
                .header("X-Antnest-Expected-Execution-ID", "execution-1")
                .body(Body::from(digest))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let value = body_json(response).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["code"], "maintenance_unavailable");
    declare_error(
        "POST",
        "/internal/skill-maintenance/{action}",
        "maintenance_unavailable",
        StatusCode::SERVICE_UNAVAILABLE,
    );

    let artifact = prepared_zip();
    let package = crate::skill_package_zip::validate_skill_zip(&artifact).unwrap();
    let metadata = json!({
        "action": "install",
        "request_id": "request-1",
        "job_id": "job-1",
        "generation": 1,
        "package_path": ".antnest/skills/retry-timeouts",
        "expected_base_digest": null,
        "target_digest": package.content_digest,
        "artifact_digest": package.artifact_digest,
        "package_rules_version": 1,
    });
    assert_valid(
        "skill-maintenance.schema.json#/$defs/install_request",
        &metadata,
    );
    let install = prepared_body(&metadata, &artifact);
    let token = signed(&pair, &install, |payload| {
        payload["action"] = json!("install");
        payload["issued_at"] = json!(now);
        payload["expires_at"] = json!(now + 60);
    });
    let response = skill_maintenance_router(status, keys)
        .oneshot(
            Request::post("/internal/skill-maintenance/install")
                .header("authorization", token)
                .header(
                    "content-type",
                    "multipart/form-data; boundary=skill-boundary",
                )
                .header("X-Antnest-Expected-Execution-ID", "execution-1")
                .body(Body::from(install))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let value = body_json(response).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["code"], "maintenance_unavailable");
}

#[tokio::test]
async fn temporary_route_real_requests_and_replies_validate_against_published_schemas() {
    use crate::mcp::RuntimeStatus;
    use crate::skill_maintenance_auth_tests::{fixture, signed};
    use crate::skill_temporary_http::temporary_skill_router;
    use std::time::{SystemTime, UNIX_EPOCH};

    let (pair, identity, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(identity, "execution-1");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let disabled = temporary_skill_router(status.clone(), vec![], None)
        .oneshot(
            Request::post("/internal/skill-temporary/release")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(disabled.status(), StatusCode::FORBIDDEN);
    let value = body_json(disabled).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["error"]["code"], "temporary_disabled");
    declare_error(
        "POST",
        "/internal/skill-temporary/{action}",
        "temporary_disabled",
        StatusCode::FORBIDDEN,
    );

    let unknown = temporary_skill_router(status.clone(), keys.clone(), None)
        .oneshot(
            Request::post("/internal/skill-temporary/promote")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    let value = body_json(unknown).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["error"]["code"], "unknown_action");
    declare_error(
        "POST",
        "/internal/skill-temporary/{action}",
        "unknown_action",
        StatusCode::NOT_FOUND,
    );

    let release = serde_json::to_vec(&json!({
        "action": "temporary_release",
        "request_id": "request-1",
        "job_id": "run-1",
        "generation": 1,
    }))
    .unwrap();
    assert_valid(
        "temporary-skills.schema.json#/$defs/release_request",
        &serde_json::from_slice::<Value>(&release).unwrap(),
    );
    let token = signed(&pair, &release, |payload| {
        payload["action"] = json!("temporary_release");
        payload["job_id"] = json!("run-1");
        payload["issued_at"] = json!(now);
        payload["expires_at"] = json!(now + 60);
    });
    let response = temporary_skill_router(status, keys, None)
        .oneshot(
            Request::post("/internal/skill-temporary/release")
                .header("authorization", token)
                .header("content-type", "application/json")
                .body(Body::from(release))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let value = body_json(response).await;
    assert_valid("../common/error.schema.json", &value);
    assert_eq!(value["error"]["code"], "temporary_unavailable");
    declare_error(
        "POST",
        "/internal/skill-temporary/{action}",
        "temporary_unavailable",
        StatusCode::SERVICE_UNAVAILABLE,
    );

    for (golden, reference) in [
        (
            "temporary-install.installed.json",
            "temporary-skills.schema.json#/$defs/install_reply",
        ),
        (
            "temporary-release.released.json",
            "temporary-skills.schema.json#/$defs/release_reply",
        ),
        (
            "temporary-operation.disabled.json",
            "temporary-skills.schema.json#/$defs/error_reply",
        ),
    ] {
        let document: Value = serde_json::from_str(
            &std::fs::read_to_string(format!(
                "{}/../../contracts/runtime/examples/{golden}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        )
        .unwrap();
        assert_valid(reference, &document);
    }
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn mcp_mount_answers_a_schema_valid_protocol_response() {
    use crate::mcp::{RuntimeHttp, RuntimeStatus};
    use crate::roots::NamedRoots;
    use crate::spec::RuntimeIdentity;
    use std::sync::Arc;
    use std::time::Duration;

    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let roots = Arc::new(NamedRoots::open(workspace.path(), skills.path()).unwrap());
    let status = RuntimeStatus::with_execution_id(
        RuntimeIdentity::new("agent-1", 1).unwrap(),
        "execution-1",
    );
    let execution = status.execution_id().to_owned();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shutdown = tokio_util::sync::CancellationToken::new();
    let running =
        tokio::spawn(RuntimeHttp::new_in_process(status, roots).serve(listener, shutdown.clone()));

    let exchange = async {
        let client = reqwest::Client::new();
        let base = format!("http://localhost:{port}");
        let host = format!("localhost:{port}");

        let live = client
            .get(format!("{base}/status/live"))
            .header("host", &host)
            .send()
            .await
            .unwrap();
        assert_eq!(live.status(), StatusCode::OK);
        let live_body: Value = live.json().await.unwrap();

        let live_head = client
            .head(format!("{base}/status/live"))
            .header("host", &host)
            .send()
            .await
            .unwrap();
        assert_eq!(live_head.status(), StatusCode::OK);
        let head_empty = live_head.bytes().await.unwrap().is_empty();

        let full = client
            .get(format!("{base}/status"))
            .header("host", &host)
            .header(
                crate::service_auth::SERVICE_HEADER,
                crate::service_auth::test_header(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        let full_body: Value = full.json().await.unwrap();

        let request = json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": contract()["mcp_protocol_version"].as_str().unwrap(),
                "capabilities": {},
                "clientInfo": {"name": "contract-test", "version": "0.1.0"},
            },
            "id": 1,
        });
        let response = client
            .post(format!("{base}/mcp"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("host", &host)
            .header(
                crate::service_auth::SERVICE_HEADER,
                crate::service_auth::test_header(),
            )
            .header("X-Antnest-Expected-Execution-ID", &execution)
            .json(&request)
            .send()
            .await
            .unwrap();
        let status_code = response.status().as_u16();
        let text = response.text().await.unwrap();
        (live_body, head_empty, full_body, request, status_code, text)
    };

    let outcome = tokio::time::timeout(Duration::from_secs(30), exchange).await;
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .expect("server shutdown timed out")
        .expect("server task failed")
        .expect("HTTP server failed");
    let (live_body, head_empty, full_body, request, status_code, text) =
        outcome.expect("bounded HTTP exchange timed out");

    assert_valid("http.schema.json#/$defs/live_status", &live_body);
    assert!(head_empty, "HEAD /status/live must not carry a body");
    assert_valid("runtime-status.schema.json", &full_body);
    assert_valid("http.schema.json#/$defs/protocol_request", &request);
    assert_eq!(status_code, 200, "{text}");
    let message: Value = if let Some(data) = text
        .lines()
        .find_map(|line| line.strip_prefix("data:").map(str::trim))
    {
        serde_json::from_str(data).unwrap()
    } else {
        serde_json::from_str(&text).unwrap()
    };
    assert_valid("http.schema.json#/$defs/protocol_response", &message);
}
