use crate::skill_maintenance_auth::MaintenanceTicket;
use crate::skill_package_zip::validate_skill_zip;
use crate::skill_temporary_request::{parse_temporary_install, parse_temporary_release};
use axum::body::Bytes;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{Cursor, Write};
use zip::{ZipWriter, write::SimpleFileOptions};

fn ticket(action: &str) -> MaintenanceTicket {
    MaintenanceTicket {
        organization_id: "org1".into(),
        agent_id: "agent1".into(),
        execution_id: "execution1".into(),
        job_id: "run1".into(),
        generation: 1,
        action: action.into(),
        request_id: "request1".into(),
        body_sha256: format!("sha256:{}", "a".repeat(64)),
        issued_at: 1,
        expires_at: 61,
    }
}
fn archive() -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(b"---\nname: temporary-check\ndescription: Check locally\n---\nCheck.\n")
        .unwrap();
    writer.finish().unwrap().into_inner()
}
fn multipart(metadata: &Value, bytes: &[u8]) -> Bytes {
    let mut body =
        b"--temporary\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n".to_vec();
    body.extend(serde_json::to_vec(metadata).unwrap());
    body.extend(b"\r\n--temporary\r\nContent-Disposition: form-data; name=\"artifact\"\r\n\r\n");
    body.extend(bytes);
    body.extend(b"\r\n--temporary--\r\n");
    body.into()
}
#[tokio::test]
async fn install_binds_run_and_exact_bytes_and_rejects_paths_and_learning_actions() {
    let bytes = archive();
    let package = validate_skill_zip(&bytes).unwrap();
    let metadata = json!({"action":"temporary_install","request_id":"request1","job_id":"run1","generation":1,"content_digest":package.content_digest,"artifact_digest":package.artifact_digest,"package_rules_version":1});
    let parsed = parse_temporary_install(
        "multipart/form-data; boundary=temporary",
        multipart(&metadata, &bytes),
        &ticket("temporary_install"),
    )
    .await
    .unwrap();
    let request = parsed.into_executor_request(&ticket("temporary_install"));
    assert_eq!(STANDARD.decode(request.artifact_base64).unwrap(), bytes);
    assert_eq!(request.job_id, "run1");
    for (field, value) in [
        ("job_id", json!("other-run")),
        ("request_id", json!("other-request")),
        ("generation", json!(2)),
        ("action", json!("prepare")),
        (
            "content_digest",
            json!(format!("sha256:{}", "a".repeat(64))),
        ),
        ("package_rules_version", json!(2)),
        ("path", json!("/skills/overwrite")),
    ] {
        let mut changed = metadata.clone();
        changed[field] = value;
        assert!(
            parse_temporary_install(
                "multipart/form-data; boundary=temporary",
                multipart(&changed, &bytes),
                &ticket("temporary_install")
            )
            .await
            .is_err(),
            "{field}"
        );
    }
    assert!(
        parse_temporary_install(
            "multipart/form-data; boundary=temporary",
            multipart(&metadata, &bytes),
            &ticket("prepare")
        )
        .await
        .is_err()
    );
}
#[test]
fn release_is_strict_and_cannot_target_another_run_or_directory() {
    let input = json!({"action":"temporary_release","request_id":"request1","job_id":"run1","generation":1});
    assert!(
        parse_temporary_release(
            &serde_json::to_vec(&input).unwrap(),
            &ticket("temporary_release")
        )
        .is_ok()
    );
    for (field, value) in [
        ("job_id", json!("run2")),
        ("generation", json!(2)),
        ("path", json!("/workspace")),
    ] {
        let mut changed = input.clone();
        changed[field] = value;
        assert!(
            parse_temporary_release(
                &serde_json::to_vec(&changed).unwrap(),
                &ticket("temporary_release")
            )
            .is_err()
        );
    }
    assert!(parse_temporary_release(br#"{"action":"temporary_release","request_id":"request1","job_id":"run1","job_id":"run1","generation":1}"#,&ticket("temporary_release")).is_err());
}
