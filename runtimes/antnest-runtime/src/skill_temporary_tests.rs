#![cfg(target_os = "linux")]

use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::fs;
use std::io::{Cursor, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use zip::{ZipWriter, write::SimpleFileOptions};

use crate::roots::NamedRoots;
use crate::skill_package_zip::validate_skill_zip;
use crate::skill_temporary::{
    TemporaryInstallRequest, TemporaryReleaseRequest, clean_temporary, install_temporary,
    release_temporary,
};

fn archive(name: &str) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(
            format!(
                "---\nname: {name}\ndescription: Run a local check\n---\nRun scripts/check.sh.\n"
            )
            .as_bytes(),
        )
        .unwrap();
    writer
        .start_file(
            "scripts/check.sh",
            SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    writer
        .write_all(b"#!/bin/sh\nprintf 'temporary-check-ok\\n'\n")
        .unwrap();
    writer.finish().unwrap().into_inner()
}

fn request(name: &str) -> TemporaryInstallRequest {
    let bytes = archive(name);
    let package = validate_skill_zip(&bytes).unwrap();
    TemporaryInstallRequest {
        agent_id: "agent1".into(),
        execution_id: "execution1".into(),
        job_id: "run1".into(),
        request_id: name.into(),
        content_digest: package.content_digest,
        artifact_digest: package.artifact_digest,
        artifact_base64: STANDARD.encode(bytes),
    }
}

fn scope(request: &TemporaryInstallRequest) -> TemporaryReleaseRequest {
    TemporaryReleaseRequest {
        agent_id: request.agent_id.clone(),
        execution_id: request.execution_id.clone(),
        job_id: request.job_id.clone(),
    }
}

#[test]
fn temporary_files_are_real_and_reused_only_when_complete_current_bytes_match() {
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
    let input = request("temporary-check");
    let installed = install_temporary(&roots, input.clone()).unwrap();
    let relative = installed
        .temporary_path
        .strip_prefix("/workspace/")
        .unwrap();
    let path = workspace.path().join(relative);
    assert!(path.join("SKILL.md").is_file());
    assert!(!path.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(
        path.join("scripts/check.sh")
            .metadata()
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let reused = install_temporary(&roots, input.clone()).unwrap();
    assert_eq!(reused.temporary_path, installed.temporary_path);
    let mut another_call = input.clone();
    another_call.request_id = "new-load-call".into();
    assert!(install_temporary(&roots, another_call).is_ok());
    fs::write(path.join("unexpected.txt"), "changed").unwrap();
    assert!(install_temporary(&roots, input.clone()).is_err());
    assert_eq!(
        fs::read_to_string(path.join("unexpected.txt")).unwrap(),
        "changed"
    );
    release_temporary(&roots, scope(&input)).unwrap();
    assert!(!path.exists());
    release_temporary(&roots, scope(&input)).unwrap();
}

#[test]
fn temporary_cleanup_preserves_personal_and_system_skills_and_checks_real_package_quota() {
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    fs::create_dir_all(workspace.path().join(".antnest/skills/personal")).unwrap();
    fs::write(
        workspace.path().join(".antnest/skills/personal/SKILL.md"),
        "personal",
    )
    .unwrap();
    fs::write(skills.path().join("system.txt"), "system").unwrap();
    let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
    for name in ["first-check", "second-check", "third-check", "fourth-check"] {
        install_temporary(&roots, request(name)).unwrap();
    }
    assert!(install_temporary(&roots, request("fifth-check")).is_err());
    clean_temporary(&roots).unwrap();
    assert_eq!(
        fs::read_to_string(workspace.path().join(".antnest/skills/personal/SKILL.md")).unwrap(),
        "personal"
    );
    assert_eq!(
        fs::read_to_string(skills.path().join("system.txt")).unwrap(),
        "system"
    );
    assert!(
        !workspace
            .path()
            .join(".antnest/skill-temporary/v1")
            .exists()
    );
}

#[test]
fn temporary_namespace_never_follows_a_workspace_symlink() {
    let workspace = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("keep.txt"), "keep").unwrap();
    fs::create_dir(workspace.path().join(".antnest")).unwrap();
    symlink(
        external.path(),
        workspace.path().join(".antnest/skill-temporary"),
    )
    .unwrap();
    let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
    assert!(install_temporary(&roots, request("temporary-check")).is_err());
    assert!(clean_temporary(&roots).is_err());
    assert_eq!(
        fs::read_to_string(external.path().join("keep.txt")).unwrap(),
        "keep"
    );
}
