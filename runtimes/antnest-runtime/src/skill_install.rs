// Executor side of the private Skill learning install and digest actions.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::roots::{NamedRoots, RootError, TreeEntry, TreeFile, TreeInstallMode};
use crate::skill_package_manifest::validate_skill_manifest;
use crate::skill_package_zip::validate_skill_zip;
use crate::tool_error::{ToolError, ToolErrorCode};

pub(crate) const INSTALL_STAGING: &str = ".antnest/skill-learning/staging";
const STAGED_INSTALL: &str = "install";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillInstallRequest {
    pub(crate) package_path: String,
    pub(crate) expected_base_digest: Option<String>,
    pub(crate) target_digest: String,
    pub(crate) artifact_digest: String,
    pub(crate) artifact_base64: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConflictReason {
    BaseChanged,
    TargetExists,
    ContentChangedDuringActivation,
}

impl ConflictReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::BaseChanged => "base_changed",
            Self::TargetExists => "target_exists",
            Self::ContentChangedDuringActivation => "content_changed_during_activation",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SkillInstalled {
    Applied {
        observed_digest: String,
    },
    Conflict {
        conflict_reason: ConflictReason,
        observed_digest: Option<String>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillDigestRequest {
    pub(crate) package_path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillDigestObserved {
    pub(crate) observed_digest: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillInstallStagingCleaned {}

pub(crate) fn install_skill(
    roots: &NamedRoots,
    request: SkillInstallRequest,
) -> Result<SkillInstalled, ToolError> {
    #[cfg(feature = "skill-maintenance-e2e-gate")]
    let after_rename = e2e_gate_after_rename;
    #[cfg(not(feature = "skill-maintenance-e2e-gate"))]
    let after_rename = || {};
    install_skill_with_hook(roots, request, after_rename)
}

#[cfg(feature = "skill-maintenance-e2e-gate")]
fn e2e_gate_after_rename() {
    use std::time::{Duration, Instant};

    let gate = std::path::Path::new("/workspace/.antnest/skill-learning/e2e-install-gate");
    if !gate.join("hold").is_file() {
        return;
    }
    std::fs::write(gate.join("entered"), b"installed").expect("write Skill E2E gate marker");
    let deadline = Instant::now() + Duration::from_secs(120);
    while !gate.join("release").exists() {
        assert!(
            Instant::now() < deadline,
            "Skill E2E gate release timed out"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(crate) fn install_skill_with_hook(
    roots: &NamedRoots,
    request: SkillInstallRequest,
    after_rename: impl FnOnce(),
) -> Result<SkillInstalled, ToolError> {
    let skill_name = managed_skill_name(&request.package_path)?;
    if !valid_digest(&request.target_digest)
        || !valid_digest(&request.artifact_digest)
        || request
            .expected_base_digest
            .as_deref()
            .is_some_and(|value| !valid_digest(value))
    {
        return Err(ToolError::invalid_params("invalid Skill install identity"));
    }
    let artifact = STANDARD
        .decode(&request.artifact_base64)
        .map_err(|_| ToolError::invalid_params("invalid Skill install encoding"))?;
    let package = validate_skill_zip(&artifact).map_err(ToolError::invalid_params)?;
    if package.name != skill_name
        || request.artifact_digest != package.artifact_digest
        || request.target_digest != package.content_digest
    {
        return Err(ToolError::invalid_params(
            "Skill install content identity differs",
        ));
    }

    roots
        .remove_skill_install_staging()
        .map_err(|error| ToolError::new(ToolErrorCode::WriteFailed, error))?;
    let paths = package
        .files
        .iter()
        .map(|file| format!("package/{}", file.path))
        .collect::<Vec<_>>();
    let files = package
        .files
        .iter()
        .zip(&paths)
        .map(|(file, path)| TreeFile {
            path: path.as_str(),
            contents: &file.contents,
            executable: file.executable,
        })
        .collect::<Vec<_>>();
    let result = (|| {
        roots
            .publish_workspace_tree(INSTALL_STAGING, STAGED_INSTALL, &files)
            .map_err(|error| ToolError::new(ToolErrorCode::WriteFailed, error))?;
        let staged = roots
            .snapshot_workspace_tree(&format!("{INSTALL_STAGING}/{STAGED_INSTALL}/package"))
            .map_err(|_| ToolError::invalid_params("staged Skill package is unreadable"))?;
        if digest_snapshot(&staged, &request.package_path)? != request.target_digest {
            return Err(ToolError::invalid_params(
                "staged Skill package differs from the target",
            ));
        }
        activate(roots, &request, skill_name, after_rename)
    })();
    // The next install or Runtime startup removes anything left behind.
    let _ = roots.remove_skill_install_staging();
    result
}

fn activate(
    roots: &NamedRoots,
    request: &SkillInstallRequest,
    skill_name: &str,
    after_rename: impl FnOnce(),
) -> Result<SkillInstalled, ToolError> {
    let current = match active_digest(roots, &request.package_path) {
        Ok(current) => current,
        Err(_) => {
            return Ok(conflict(ConflictReason::BaseChanged, None));
        }
    };
    if current.as_deref() == Some(request.target_digest.as_str()) {
        roots
            .sync_managed_skill_tree(skill_name)
            .map_err(|error| ToolError::new(ToolErrorCode::WriteFailed, error))?;
        return Ok(SkillInstalled::Applied {
            observed_digest: request.target_digest.clone(),
        });
    }
    let mode = match (&request.expected_base_digest, &current) {
        (None, None) => TreeInstallMode::Create,
        (None, Some(_)) => return Ok(conflict(ConflictReason::TargetExists, current)),
        (Some(base), Some(active)) if base == active => TreeInstallMode::Replace,
        _ => return Ok(conflict(ConflictReason::BaseChanged, current)),
    };
    match roots.install_staged_skill_tree(skill_name, mode) {
        Ok(()) => {}
        #[cfg(target_os = "linux")]
        Err(RootError::AtomicSkillReplaceUnsupported(error)) => {
            return Err(ToolError::new(
                ToolErrorCode::AtomicSkillReplaceUnsupported,
                error,
            ));
        }
        // A writer created or removed the package between the digest check
        // and the rename; the rename did not happen.
        Err(error) if system_error_kind(&error) == Some(std::io::ErrorKind::AlreadyExists) => {
            return Ok(conflict(
                ConflictReason::TargetExists,
                active_digest(roots, &request.package_path).unwrap_or(None),
            ));
        }
        Err(error) if error.is_not_found() => {
            return Ok(conflict(ConflictReason::BaseChanged, None));
        }
        Err(error) if error.outcome_unknown() => return Err(ToolError::outcome_unknown(error)),
        Err(error) => return Err(ToolError::new(ToolErrorCode::WriteFailed, error)),
    }
    after_rename();
    match active_digest(roots, &request.package_path) {
        Ok(Some(observed)) if observed == request.target_digest => Ok(SkillInstalled::Applied {
            observed_digest: observed,
        }),
        Ok(observed) => Ok(conflict(
            ConflictReason::ContentChangedDuringActivation,
            observed,
        )),
        Err(_) => Ok(conflict(
            ConflictReason::ContentChangedDuringActivation,
            None,
        )),
    }
}

pub(crate) fn skill_digest(
    roots: &NamedRoots,
    request: SkillDigestRequest,
) -> Result<SkillDigestObserved, ToolError> {
    managed_skill_name(&request.package_path)?;
    Ok(SkillDigestObserved {
        observed_digest: active_digest(roots, &request.package_path)?,
    })
}

pub(crate) fn clean_install_staging(roots: &NamedRoots) -> Result<(), ToolError> {
    roots
        .remove_skill_install_staging()
        .map_err(|error| ToolError::new(ToolErrorCode::WriteFailed, error))
}

fn conflict(conflict_reason: ConflictReason, observed_digest: Option<String>) -> SkillInstalled {
    SkillInstalled::Conflict {
        conflict_reason,
        observed_digest,
    }
}

#[cfg(target_os = "linux")]
fn system_error_kind(error: &RootError) -> Option<std::io::ErrorKind> {
    match error {
        RootError::System { source, .. } => Some(source.kind()),
        _ => None,
    }
}

#[cfg(not(target_os = "linux"))]
fn system_error_kind(_error: &RootError) -> Option<std::io::ErrorKind> {
    None
}

fn managed_skill_name(package_path: &str) -> Result<&str, ToolError> {
    package_path
        .strip_prefix(".antnest/skills/")
        .filter(|name| valid_skill_name(name))
        .ok_or_else(|| ToolError::invalid_params("invalid managed Skill path"))
}

pub(crate) fn active_digest(roots: &NamedRoots, path: &str) -> Result<Option<String>, ToolError> {
    match roots.snapshot_workspace_tree(path) {
        Ok(entries) => digest_snapshot(&entries, path).map(Some),
        Err(error) if error.is_not_found() => Ok(None),
        Err(_) => Err(ToolError::invalid_params(
            "managed Skill activity is unreadable",
        )),
    }
}

/// Registry canonical regular-file manifest digest of a package tree.
pub(crate) fn digest_snapshot(
    entries: &[TreeEntry],
    package_path: &str,
) -> Result<String, ToolError> {
    let files = entries
        .iter()
        .filter(|entry| entry.contents.is_some())
        .collect::<Vec<_>>();
    if files.is_empty() || files.len() > 256 {
        return Err(ToolError::invalid_params("invalid candidate inventory"));
    }
    let mut expected_directories = BTreeSet::new();
    let mut total = 0usize;
    let mut manifest = None;
    let mut canonical = Sha256::new();
    canonical.update(b"antnest-skill-manifest-v1\0");
    for file in files {
        let path = &file.path;
        let contents = file.contents.as_ref().expect("selected file");
        if path.is_empty()
            || path.len() > 512
            || path.contains(['\\', '\0'])
            || path.split('/').count() > 16
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
            || (path == "SKILL.md" && contents.len() > 16 * 1024)
        {
            return Err(ToolError::invalid_params("invalid candidate package path"));
        }
        total = total.saturating_add(contents.len());
        if total > 32 * 1024 * 1024 {
            return Err(ToolError::invalid_params("candidate package exceeds limit"));
        }
        if path == "SKILL.md" {
            manifest = Some(validate_skill_manifest(contents).map_err(ToolError::invalid_params)?);
        }
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            expected_directories.insert(prefix.to_owned());
            parent = prefix;
        }
        canonical.update((path.len() as u32).to_be_bytes());
        canonical.update(path.as_bytes());
        canonical.update((contents.len() as u64).to_be_bytes());
        canonical.update(Sha256::digest(contents));
        canonical.update([u8::from(file.executable)]);
    }
    if entries.len()
        != entries
            .iter()
            .filter(|entry| entry.contents.is_some())
            .count()
            + expected_directories.len()
        || entries
            .iter()
            .filter(|entry| entry.contents.is_none())
            .any(|entry| !expected_directories.contains(&entry.path))
    {
        return Err(ToolError::invalid_params(
            "candidate directory inventory has changed",
        ));
    }
    let manifest = manifest.ok_or_else(|| ToolError::invalid_params("SKILL.md is missing"))?;
    if package_path != format!(".antnest/skills/{}", manifest.name) {
        return Err(ToolError::invalid_params(
            "candidate Skill identity has changed",
        ));
    }
    Ok(format!(
        "sha256:{}",
        canonical
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn valid_skill_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
