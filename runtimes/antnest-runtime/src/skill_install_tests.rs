use std::fs;
use std::io::{Cursor, Write};
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use tempfile::{TempDir, tempdir};
use zip::{ZipWriter, write::SimpleFileOptions};

use crate::roots::NamedRoots;
use crate::skill_install::{
    ConflictReason, INSTALL_STAGING, SkillDigestRequest, SkillInstallRequest, SkillInstalled,
    clean_install_staging, install_skill, install_skill_with_hook, skill_digest,
};
use crate::skill_package_zip::validate_skill_zip;

const PATH: &str = ".antnest/skills/retry-timeouts";

struct Fixture {
    workspace: TempDir,
    _skills: TempDir,
    roots: NamedRoots,
}

fn fixture() -> Fixture {
    let workspace = tempdir().expect("workspace");
    let skills = tempdir().expect("system Skills");
    let roots = NamedRoots::open(workspace.path(), skills.path()).expect("roots");
    Fixture {
        workspace,
        _skills: skills,
        roots,
    }
}

fn package(description: &str, extra: Option<(&str, &[u8])>) -> (Vec<u8>, String) {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(
            format!("---\nname: retry-timeouts\ndescription: {description}\n---\n").as_bytes(),
        )
        .unwrap();
    if let Some((path, contents)) = extra {
        writer
            .start_file(path, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents).unwrap();
    }
    let artifact = writer.finish().unwrap().into_inner();
    let digest = validate_skill_zip(&artifact).unwrap().content_digest;
    (artifact, digest)
}

fn request(artifact: &[u8], base: Option<&str>) -> SkillInstallRequest {
    let package = validate_skill_zip(artifact).unwrap();
    SkillInstallRequest {
        package_path: PATH.into(),
        expected_base_digest: base.map(str::to_owned),
        target_digest: package.content_digest,
        artifact_digest: package.artifact_digest,
        artifact_base64: STANDARD.encode(artifact),
    }
}

fn active(workspace: &Path) -> std::path::PathBuf {
    workspace.join(PATH)
}

fn staging_is_empty(workspace: &Path) -> bool {
    let staging = workspace.join(INSTALL_STAGING);
    !staging.exists() || fs::read_dir(staging).unwrap().next().is_none()
}

fn applied(result: SkillInstalled) -> String {
    match result {
        SkillInstalled::Applied { observed_digest } => observed_digest,
        other => panic!("install was not applied: {other:?}"),
    }
}

fn conflict(result: SkillInstalled) -> (ConflictReason, Option<String>) {
    match result {
        SkillInstalled::Conflict {
            conflict_reason,
            observed_digest,
        } => (conflict_reason, observed_digest),
        other => panic!("install did not conflict: {other:?}"),
    }
}

#[test]
fn new_package_is_installed_once_and_a_resend_settles_without_another_rename() {
    let fixture = fixture();
    let (artifact, target) = package("Retry safely", Some(("scripts/check.sh", b"exit 0\n")));
    let observed = applied(install_skill(&fixture.roots, request(&artifact, None)).unwrap());
    assert_eq!(observed, target);
    let installed = active(fixture.workspace.path());
    assert!(installed.join("SKILL.md").is_file());
    assert_eq!(
        fs::read(installed.join("scripts/check.sh")).unwrap(),
        b"exit 0\n"
    );
    assert!(staging_is_empty(fixture.workspace.path()));
    let inode = fs::metadata(&installed).unwrap().ino();

    let resent = applied(install_skill(&fixture.roots, request(&artifact, None)).unwrap());
    assert_eq!(resent, target);
    assert_eq!(
        fs::metadata(&installed).unwrap().ino(),
        inode,
        "a resend of an applied install must not rename again"
    );
    assert!(staging_is_empty(fixture.workspace.path()));
}

#[test]
fn update_exchanges_complete_directories_and_drops_the_old_version() {
    let fixture = fixture();
    let (first, base) = package("Retry safely", Some(("notes/old.md", b"old\n")));
    applied(install_skill(&fixture.roots, request(&first, None)).unwrap());
    let (second, target) = package("Retry safely with backoff", None);

    let observed = applied(install_skill(&fixture.roots, request(&second, Some(&base))).unwrap());
    assert_eq!(observed, target);
    let installed = active(fixture.workspace.path());
    assert!(
        fs::read_to_string(installed.join("SKILL.md"))
            .unwrap()
            .contains("with backoff")
    );
    assert!(
        !installed.join("notes").exists(),
        "an update must replace the whole package, not merge files"
    );
    assert!(staging_is_empty(fixture.workspace.path()));

    let resent = applied(install_skill(&fixture.roots, request(&second, Some(&base))).unwrap());
    assert_eq!(resent, target);
}

#[test]
fn null_base_with_an_existing_different_package_is_target_exists() {
    let fixture = fixture();
    let (first, existing) = package("Retry safely", None);
    applied(install_skill(&fixture.roots, request(&first, None)).unwrap());
    let (second, _) = package("Someone else's rule", None);

    let (reason, observed) =
        conflict(install_skill(&fixture.roots, request(&second, None)).unwrap());
    assert_eq!(reason, ConflictReason::TargetExists);
    assert_eq!(observed.as_deref(), Some(existing.as_str()));
    assert!(
        fs::read_to_string(active(fixture.workspace.path()).join("SKILL.md"))
            .unwrap()
            .contains("Retry safely")
    );
    assert!(staging_is_empty(fixture.workspace.path()));
}

#[test]
fn changed_or_missing_base_is_base_changed_and_leaves_the_active_package() {
    let fixture = fixture();
    let (first, _) = package("Retry safely", None);
    let (second, _) = package("Retry safely with backoff", None);
    let stale_base = format!("sha256:{}", "0".repeat(64));

    let (reason, observed) =
        conflict(install_skill(&fixture.roots, request(&second, Some(&stale_base))).unwrap());
    assert_eq!(reason, ConflictReason::BaseChanged);
    assert_eq!(observed, None);
    assert!(!active(fixture.workspace.path()).exists());

    let current = applied(install_skill(&fixture.roots, request(&first, None)).unwrap());
    let (reason, observed) =
        conflict(install_skill(&fixture.roots, request(&second, Some(&stale_base))).unwrap());
    assert_eq!(reason, ConflictReason::BaseChanged);
    assert_eq!(observed.as_deref(), Some(current.as_str()));
    assert!(
        fs::read_to_string(active(fixture.workspace.path()).join("SKILL.md"))
            .unwrap()
            .contains("Retry safely\n")
    );
    assert!(staging_is_empty(fixture.workspace.path()));
}

#[test]
fn stale_staging_from_an_interrupted_install_is_removed_first() {
    let fixture = fixture();
    let leftover = fixture
        .workspace
        .path()
        .join(INSTALL_STAGING)
        .join("install/package");
    fs::create_dir_all(&leftover).unwrap();
    fs::write(leftover.join("SKILL.md"), b"interrupted").unwrap();
    let hidden = fixture
        .workspace
        .path()
        .join(INSTALL_STAGING)
        .join(".install.interrupted.tmp");
    fs::create_dir_all(&hidden).unwrap();

    let (artifact, target) = package("Retry safely", None);
    assert_eq!(
        applied(install_skill(&fixture.roots, request(&artifact, None)).unwrap()),
        target
    );
    assert!(staging_is_empty(fixture.workspace.path()));
}

#[test]
fn writer_after_the_rename_is_a_conflict_without_rollback() {
    let fixture = fixture();
    let (artifact, _) = package("Retry safely", None);
    let installed = active(fixture.workspace.path()).join("SKILL.md");
    let result = install_skill_with_hook(&fixture.roots, request(&artifact, None), || {
        let mut changed = fs::read(&installed).unwrap();
        changed.extend_from_slice(b"writer changed content\n");
        fs::write(&installed, changed).unwrap();
    })
    .unwrap();
    let (reason, observed) = conflict(result);
    assert_eq!(reason, ConflictReason::ContentChangedDuringActivation);
    assert!(observed.is_some());
    assert!(
        fs::read_to_string(&installed)
            .unwrap()
            .contains("writer changed content"),
        "Runtime must never exchange back after a writer changed the package"
    );
}

#[test]
fn digest_reports_the_active_package_or_null_when_absent() {
    let fixture = fixture();
    let absent = skill_digest(
        &fixture.roots,
        SkillDigestRequest {
            package_path: PATH.into(),
        },
    )
    .unwrap();
    assert_eq!(absent.observed_digest, None);
    let (artifact, target) = package("Retry safely", None);
    applied(install_skill(&fixture.roots, request(&artifact, None)).unwrap());
    let present = skill_digest(
        &fixture.roots,
        SkillDigestRequest {
            package_path: PATH.into(),
        },
    )
    .unwrap();
    assert_eq!(present.observed_digest.as_deref(), Some(target.as_str()));
    assert!(
        skill_digest(
            &fixture.roots,
            SkillDigestRequest {
                package_path: "/skills/system".into(),
            },
        )
        .is_err()
    );
}

#[test]
fn request_identity_must_match_the_artifact() {
    let fixture = fixture();
    let (artifact, _) = package("Retry safely", None);
    let mut wrong_target = request(&artifact, None);
    wrong_target.target_digest = format!("sha256:{}", "1".repeat(64));
    assert!(install_skill(&fixture.roots, wrong_target).is_err());
    let mut wrong_path = request(&artifact, None);
    wrong_path.package_path = ".antnest/skills/other-skill".into();
    assert!(install_skill(&fixture.roots, wrong_path).is_err());
    assert!(!active(fixture.workspace.path()).exists());
    assert!(staging_is_empty(fixture.workspace.path()));
}

#[test]
fn startup_cleanup_removes_install_staging() {
    let fixture = fixture();
    let leftover = fixture
        .workspace
        .path()
        .join(INSTALL_STAGING)
        .join("install/package");
    fs::create_dir_all(&leftover).unwrap();
    fs::write(leftover.join("SKILL.md"), b"interrupted").unwrap();
    clean_install_staging(&fixture.roots).unwrap();
    assert!(staging_is_empty(fixture.workspace.path()));
    clean_install_staging(&fixture.roots).unwrap();
}
