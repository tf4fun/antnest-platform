use serde_json::{Value, json};

use crate::skill_maintenance_auth::MaintenanceTicket;
use crate::skill_maintenance_request::{parse_control_request, parse_prepare_request};
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
fn control_requests_are_exact_and_bound_to_the_signed_ticket() {
    let digest = format!("sha256:{}", "a".repeat(64));
    let cases = [
        (
            "check",
            json!({"candidate_id":"candidate-1",
            "package_path":".antnest/skills/retry-timeouts",
            "target_digest":digest, "package_rules_version":1}),
        ),
        (
            "commit",
            json!({"candidate_id":"candidate-1",
            "package_path":".antnest/skills/retry-timeouts",
            "expected_base_digest":null,
            "target_digest":digest}),
        ),
        (
            "observe",
            json!({"effect_request_id":"effect-1",
            "expected_target_digest":digest}),
        ),
        ("cancel", json!({})),
    ];
    for (action, fields) in cases {
        let mut value = common(action);
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let body = serde_json::to_vec(&value).unwrap();
        assert!(
            parse_control_request(action, &body, &ticket(action)).is_ok(),
            "{action}"
        );

        for (field, replacement) in [
            ("request_id", json!("request-2")),
            ("job_id", json!("job-2")),
            ("generation", json!(3)),
            ("action", json!("prepare")),
        ] {
            let mut changed = value.clone();
            changed[field] = replacement;
            assert!(
                parse_control_request(
                    action,
                    &serde_json::to_vec(&changed).unwrap(),
                    &ticket(action)
                )
                .is_err(),
                "{action} accepted changed {field}"
            );
        }
        let mut extra = value.clone();
        extra["privileged"] = json!(true);
        assert!(
            parse_control_request(
                action,
                &serde_json::to_vec(&extra).unwrap(),
                &ticket(action)
            )
            .is_err(),
            "{action} accepted an unknown field"
        );
    }
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

#[test]
fn commit_rejects_duplicate_keys_unsafe_paths_and_malformed_digests() {
    let digest = format!("sha256:{}", "a".repeat(64));
    let mut value = common("commit");
    value["candidate_id"] = json!("candidate-1");
    value["package_path"] = json!(".antnest/skills/retry-timeouts");
    value["expected_base_digest"] = Value::Null;
    value["target_digest"] = json!(digest);
    for path in [
        "/skills/system",
        ".antnest/skills/../escape",
        ".antnest/skills/invalid_name",
    ] {
        value["package_path"] = json!(path);
        assert!(
            parse_control_request(
                "commit",
                &serde_json::to_vec(&value).unwrap(),
                &ticket("commit")
            )
            .is_err()
        );
    }
    value["package_path"] = json!(".antnest/skills/retry-timeouts");
    value["target_digest"] = json!("sha256:NOT-A-DIGEST");
    assert!(
        parse_control_request(
            "commit",
            &serde_json::to_vec(&value).unwrap(),
            &ticket("commit")
        )
        .is_err()
    );
    let duplicate = format!(
        "{{\"action\":\"commit\",\"action\":\"commit\",\"request_id\":\"request-1\",\"job_id\":\"job-1\",\"generation\":2,\"candidate_id\":\"candidate-1\",\"package_path\":\".antnest/skills/retry-timeouts\",\"expected_base_digest\":null,\"target_digest\":\"{}\"}}",
        digest
    );
    assert!(parse_control_request("commit", duplicate.as_bytes(), &ticket("commit")).is_err());
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
async fn prepare_requires_exact_parts_and_matching_content_identity() {
    let artifact = prepared_zip();
    let package = crate::skill_package_zip::validate_skill_zip(&artifact).unwrap();
    let metadata = json!({
        "action":"prepare", "request_id":"request-1", "job_id":"job-1", "generation":2,
        "candidate_id":"candidate-1", "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null, "target_digest":package.content_digest,
        "artifact_digest":package.artifact_digest, "package_rules_version":1
    });
    let content_type = "multipart/form-data; boundary=skill-boundary";
    let body = prepared_body(&metadata, &artifact);
    let prepared = parse_prepare_request(content_type, body.clone().into(), &ticket("prepare"))
        .await
        .unwrap();
    assert_eq!(prepared.package.name, "retry-timeouts");
    assert_eq!(prepared.metadata.candidate_id, "candidate-1");

    for field in [
        "target_digest",
        "artifact_digest",
        "package_path",
        "request_id",
    ] {
        let mut changed = metadata.clone();
        changed[field] = json!("wrong");
        assert!(
            parse_prepare_request(
                content_type,
                prepared_body(&changed, &artifact).into(),
                &ticket("prepare")
            )
            .await
            .is_err(),
            "accepted {field} mismatch"
        );
    }
    let mut extra = body.clone();
    extra.extend_from_slice(b"ignored");
    assert!(
        parse_prepare_request(content_type, extra.into(), &ticket("prepare"))
            .await
            .is_err()
    );
    let mut preamble = b"ignored\r\n".to_vec();
    preamble.extend_from_slice(&body);
    assert!(
        parse_prepare_request(content_type, preamble.into(), &ticket("prepare"))
            .await
            .is_err()
    );
    let duplicate = body
        .windows(b"--skill-boundary--\r\n".len())
        .position(|part| part == b"--skill-boundary--\r\n")
        .unwrap();
    let mut duplicate_body = body[..duplicate].to_vec();
    duplicate_body.extend_from_slice(
        b"--skill-boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n{}\r\n--skill-boundary--\r\n",
    );
    assert!(
        parse_prepare_request(content_type, duplicate_body.into(), &ticket("prepare"))
            .await
            .is_err()
    );
}
