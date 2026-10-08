use serde_json::{Value, json};

use crate::skill_maintenance_auth::MaintenanceTicket;
use crate::skill_maintenance_request::{
    ControlRequest, parse_control_request, parse_install_request,
};
use std::io::{Cursor, Write};
use zip::{ZipWriter, write::SimpleFileOptions};

fn ticket(action: &str) -> MaintenanceTicket {
    MaintenanceTicket {
        organization_id: "org-1".into(),
        agent_id: "agent-1".into(),
        execution_id: "execution-1".into(),
        job_id: "job-1".into(),
        generation: 2,
        action: action.into(),
        request_id: "request-1".into(),
        body_sha256: format!("sha256:{}", "a".repeat(64)),
        issued_at: 1_790_000_000,
        expires_at: 1_790_000_060,
    }
}

fn common(action: &str) -> Value {
    json!({"action":action, "request_id":"request-1", "job_id":"job-1",
        "generation":2})
}

#[test]
fn out_of_scope_revert_action_is_rejected() {
    let mut value = common("revert");
    value["reverted_change_id"] = json!("change-1");
    value["package_path"] = json!(".antnest/skills/retry-timeouts");
    value["expected_current_digest"] = json!(format!("sha256:{}", "a".repeat(64)));
    value["restore_digest"] = Value::Null;
    assert!(
        parse_control_request(
            "revert",
            &serde_json::to_vec(&value).unwrap(),
            &ticket("revert")
        )
        .is_err()
    );
}

pub(crate) fn prepared_body(metadata: &Value, artifact: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    result.extend_from_slice(b"--skill-boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n");
    result.extend_from_slice(serde_json::to_string(metadata).unwrap().as_bytes());
    result.extend_from_slice(b"\r\n--skill-boundary\r\nContent-Disposition: form-data; name=\"artifact\"; filename=\"candidate.zip\"\r\nContent-Type: application/zip\r\n\r\n");
    result.extend_from_slice(artifact);
    result.extend_from_slice(b"\r\n--skill-boundary--\r\n");
    result
}

pub(crate) fn prepared_zip() -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(b"---\nname: retry-timeouts\ndescription: Retry safely\n---\n")
        .unwrap();
    writer.finish().unwrap().into_inner()
}

#[tokio::test]
async fn install_requires_exact_parts_and_matching_content_identity() {
    let artifact = prepared_zip();
    let package = crate::skill_package_zip::validate_skill_zip(&artifact).unwrap();
    let metadata = json!({
        "action":"install", "request_id":"request-1", "job_id":"job-1", "generation":2,
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null, "target_digest":package.content_digest,
        "artifact_digest":package.artifact_digest, "package_rules_version":1
    });
    let content_type = "multipart/form-data; boundary=skill-boundary";
    let body = prepared_body(&metadata, &artifact);
    let install = parse_install_request(content_type, body.clone().into(), &ticket("install"))
        .await
        .unwrap();
    let request = install.into_executor_request();
    assert_eq!(request.package_path, ".antnest/skills/retry-timeouts");
    assert_eq!(request.target_digest, package.content_digest);
    assert_eq!(request.artifact_digest, package.artifact_digest);
    assert!(
        parse_install_request(content_type, body.into(), &ticket("prepare"))
            .await
            .is_err(),
        "install accepted a ticket signed for another action"
    );

    for (field, replacement) in [
        ("target_digest", json!(format!("sha256:{}", "b".repeat(64)))),
        (
            "artifact_digest",
            json!(format!("sha256:{}", "b".repeat(64))),
        ),
        ("package_path", json!(".antnest/skills/other-skill")),
        ("request_id", json!("request-2")),
        ("job_id", json!("job-2")),
        ("generation", json!(3)),
        ("action", json!("prepare")),
        ("expected_base_digest", json!("sha256:NOT-A-DIGEST")),
        ("package_rules_version", json!(2)),
    ] {
        let mut changed = metadata.clone();
        changed[field] = replacement;
        assert!(
            parse_install_request(
                content_type,
                prepared_body(&changed, &artifact).into(),
                &ticket("install")
            )
            .await
            .is_err(),
            "accepted {field} mismatch"
        );
    }
    for field in ["candidate_id", "storage_key"] {
        let mut extra = metadata.clone();
        extra[field] = json!("candidate-1");
        assert!(
            parse_install_request(
                content_type,
                prepared_body(&extra, &artifact).into(),
                &ticket("install")
            )
            .await
            .is_err(),
            "install accepted removed field {field}"
        );
    }
}

#[test]
fn digest_requests_are_exact_and_bound_to_the_signed_ticket() {
    let mut value = common("digest");
    value["package_path"] = json!(".antnest/skills/retry-timeouts");
    let body = serde_json::to_vec(&value).unwrap();
    match parse_control_request("digest", &body, &ticket("digest")) {
        Ok(ControlRequest::Digest(request)) => {
            assert_eq!(request.package_path(), ".antnest/skills/retry-timeouts");
        }
        other => panic!("digest request was not parsed: {other:?}"),
    }
    assert!(parse_control_request("digest", &body, &ticket("install")).is_err());
    for (field, replacement) in [
        ("request_id", json!("request-2")),
        ("job_id", json!("job-2")),
        ("generation", json!(3)),
        ("action", json!("observe")),
        ("package_path", json!("/skills/system")),
        ("package_path", json!(".antnest/skills/../escape")),
    ] {
        let mut changed = value.clone();
        changed[field] = replacement;
        assert!(
            parse_control_request(
                "digest",
                &serde_json::to_vec(&changed).unwrap(),
                &ticket("digest")
            )
            .is_err(),
            "digest accepted changed {field}"
        );
    }
    let mut extra = value.clone();
    extra["expected_target_digest"] = json!(format!("sha256:{}", "a".repeat(64)));
    assert!(
        parse_control_request(
            "digest",
            &serde_json::to_vec(&extra).unwrap(),
            &ticket("digest")
        )
        .is_err()
    );
}

#[tokio::test]
async fn retired_transaction_actions_are_unknown_even_when_signed() {
    use crate::mcp::{RuntimeStatus, skill_maintenance_router};
    use crate::skill_maintenance_auth_tests::{fixture, signed};
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt as _;

    let (pair, identity, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(identity, "execution-1");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    for action in ["prepare", "check", "commit", "observe", "cancel", "release"] {
        let body = serde_json::to_vec(&common(action)).unwrap();
        assert!(
            parse_control_request(action, &body, &ticket(action)).is_err(),
            "{action} still parses"
        );
        let token = signed(&pair, &body, |payload| {
            payload["action"] = json!(action);
            payload["issued_at"] = json!(now);
            payload["expires_at"] = json!(now + 60);
        });
        let response = skill_maintenance_router(status.clone(), keys.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/internal/skill-maintenance/{action}"))
                    .header("Authorization", token)
                    .header("Content-Type", "application/json")
                    .header("X-Antnest-Expected-Execution-ID", "execution-1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{action}");
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(value["error"]["code"], "unknown_action", "{action}");
    }
}

#[tokio::test]
async fn install_and_digest_routes_authenticate_and_parse_before_the_actor() {
    use crate::mcp::{RuntimeStatus, skill_maintenance_router};
    use crate::skill_maintenance_auth_tests::{fixture, signed};
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt as _;

    let (pair, identity, keys) = fixture();
    let status = RuntimeStatus::with_execution_id(identity, "execution-1");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let artifact = prepared_zip();
    let package = crate::skill_package_zip::validate_skill_zip(&artifact).unwrap();
    let install = prepared_body(
        &json!({
            "action":"install", "request_id":"request-1", "job_id":"job-1", "generation":1,
            "package_path":".antnest/skills/retry-timeouts",
            "expected_base_digest":null, "target_digest":package.content_digest,
            "artifact_digest":package.artifact_digest, "package_rules_version":1
        }),
        &artifact,
    );
    let digest = serde_json::to_vec(&json!({
        "action":"digest", "request_id":"request-1", "job_id":"job-1", "generation":1,
        "package_path":".antnest/skills/retry-timeouts"
    }))
    .unwrap();
    let multipart = "multipart/form-data; boundary=skill-boundary";
    for (route, signed_action, content_type, body, expected, code) in [
        (
            "install",
            "install",
            multipart,
            install.clone(),
            StatusCode::SERVICE_UNAVAILABLE,
            "maintenance_unavailable",
        ),
        (
            "digest",
            "digest",
            "application/json",
            digest.clone(),
            StatusCode::SERVICE_UNAVAILABLE,
            "maintenance_unavailable",
        ),
        (
            "install",
            "prepare",
            multipart,
            install.clone(),
            StatusCode::UNAUTHORIZED,
            "maintenance_unauthorized",
        ),
        (
            "digest",
            "observe",
            "application/json",
            digest.clone(),
            StatusCode::UNAUTHORIZED,
            "maintenance_unauthorized",
        ),
        (
            "revert",
            "revert",
            "application/json",
            digest.clone(),
            StatusCode::NOT_FOUND,
            "unknown_action",
        ),
    ] {
        let token = signed(&pair, &body, |payload| {
            payload["action"] = json!(signed_action);
            payload["issued_at"] = json!(now);
            payload["expires_at"] = json!(now + 60);
        });
        let response = skill_maintenance_router(status.clone(), keys.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/internal/skill-maintenance/{route}"))
                    .header("Authorization", token)
                    .header("Content-Type", content_type)
                    .header("X-Antnest-Expected-Execution-ID", "execution-1")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            expected,
            "{route} signed as {signed_action}"
        );
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(value["error"]["code"], code, "{route}");
    }
}
