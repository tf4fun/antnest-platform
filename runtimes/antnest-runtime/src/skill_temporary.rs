use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::roots::{NamedRoot, NamedRoots, TreeEntry, TreeFile};
use crate::skill_package_zip::validate_skill_zip;
use crate::tool_error::{ToolError, ToolErrorCode};

const PARENT: &str = ".antnest/skill-temporary/v1";
const MAX_RUN_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    agent_id: String,
    execution_id: String,
    job_id: String,
    content_digest: String,
    artifact_digest: String,
    unpacked_size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TemporaryInstallRequest {
    pub(crate) agent_id: String,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) request_id: String,
    pub(crate) content_digest: String,
    pub(crate) artifact_digest: String,
    pub(crate) artifact_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TemporaryReleaseRequest {
    pub(crate) agent_id: String,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TemporaryInstalled {
    pub(crate) temporary_path: String,
    pub(crate) content_digest: String,
    pub(crate) artifact_digest: String,
    pub(crate) unpacked_size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TemporaryReleased {}

pub(crate) fn install_temporary(
    roots: &NamedRoots,
    request: TemporaryInstallRequest,
) -> Result<TemporaryInstalled, ToolError> {
    if !valid_identity(&request.agent_id)
        || !valid_identity(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_id(&request.request_id)
    {
        return Err(conflict());
    }
    let bytes = STANDARD
        .decode(&request.artifact_base64)
        .map_err(|_| conflict())?;
    let package = validate_skill_zip(&bytes).map_err(|_| conflict())?;
    if package.content_digest != request.content_digest
        || package.artifact_digest != request.artifact_digest
    {
        return Err(conflict());
    }
    let scope = scope_key(&request.agent_id, &request.execution_id, &request.job_id);
    let parent = format!("{PARENT}/{scope}");
    let key = request
        .content_digest
        .strip_prefix("sha256:")
        .ok_or_else(conflict)?
        .to_owned();
    let prefix = format!("{parent}/{key}");
    let receipt = Receipt {
        version: 1,
        agent_id: request.agent_id,
        execution_id: request.execution_id,
        job_id: request.job_id,
        content_digest: request.content_digest,
        artifact_digest: request.artifact_digest,
        unpacked_size: package.unpacked_size,
    };
    let mut retained_bytes = 0u64;
    let mut retained_count = 0usize;
    let mut reused = false;
    if roots
        .workspace_tree_exists(&parent)
        .map_err(|_| conflict())?
    {
        let listing = roots
            .list_directories(NamedRoot::Workspace, &parent, 4)
            .map_err(|_| conflict())?;
        if listing.truncated {
            return Err(limit());
        }
        for existing_key in listing.names {
            if !valid_key(&existing_key) {
                return Err(conflict());
            }
            let existing = format!("{parent}/{existing_key}");
            let actual = read_receipt(roots, &existing)?;
            if actual.version != 1
                || actual.agent_id != receipt.agent_id
                || actual.execution_id != receipt.execution_id
                || actual.job_id != receipt.job_id
                || actual.content_digest != format!("sha256:{existing_key}")
            {
                return Err(conflict());
            }
            let size = verify_files(roots, &existing, &actual)?;
            retained_bytes = retained_bytes.saturating_add(size);
            retained_count += 1;
            if existing_key == key {
                if actual != receipt {
                    return Err(conflict());
                }
                reused = true;
            }
        }
    }
    if retained_bytes > MAX_RUN_BYTES {
        return Err(limit());
    }
    if !reused {
        if retained_count >= 4
            || retained_bytes.saturating_add(package.unpacked_size) > MAX_RUN_BYTES
        {
            return Err(limit());
        }
        let record = serde_json::to_vec(&receipt)
            .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?;
        let paths = package
            .files
            .iter()
            .map(|file| format!("package/{}", file.path))
            .collect::<Vec<_>>();
        let mut files = package
            .files
            .iter()
            .zip(&paths)
            .map(|(file, path)| TreeFile {
                path,
                contents: &file.contents,
                executable: file.executable,
            })
            .collect::<Vec<_>>();
        files.push(TreeFile {
            path: "receipt.json",
            contents: &record,
            executable: false,
        });
        roots
            .publish_workspace_tree(&parent, &key, &files)
            .map_err(ToolError::outcome_unknown)?;
        if read_receipt(roots, &prefix).map_err(ToolError::outcome_unknown)? != receipt {
            return Err(ToolError::outcome_unknown(
                "Temporary package receipt did not match",
            ));
        }
        verify_files(roots, &prefix, &receipt).map_err(ToolError::outcome_unknown)?;
    }
    Ok(TemporaryInstalled {
        temporary_path: format!("/workspace/{prefix}/package"),
        content_digest: receipt.content_digest,
        artifact_digest: receipt.artifact_digest,
        unpacked_size: receipt.unpacked_size,
    })
}

pub(crate) fn release_temporary(
    roots: &NamedRoots,
    request: TemporaryReleaseRequest,
) -> Result<TemporaryReleased, ToolError> {
    if !valid_identity(&request.agent_id)
        || !valid_identity(&request.execution_id)
        || !valid_id(&request.job_id)
    {
        return Err(conflict());
    }
    let scope = scope_key(&request.agent_id, &request.execution_id, &request.job_id);
    roots
        .remove_temporary_skill_tree(Some(&scope))
        .map_err(ToolError::outcome_unknown)?;
    Ok(TemporaryReleased {})
}

pub(crate) fn clean_temporary(roots: &NamedRoots) -> Result<TemporaryReleased, ToolError> {
    roots
        .remove_temporary_skill_tree(None)
        .map_err(ToolError::outcome_unknown)?;
    Ok(TemporaryReleased {})
}

fn scope_key(agent: &str, execution: &str, run: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"antnest-skill-temporary-run-v1\0");
    for field in [agent, execution, run] {
        hash.update((field.len() as u32).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hex(&hash.finalize())
}
fn read_receipt(roots: &NamedRoots, prefix: &str) -> Result<Receipt, ToolError> {
    let preview = roots
        .read_preview(
            NamedRoot::Workspace,
            &format!("{prefix}/receipt.json"),
            4096,
        )
        .map_err(|_| conflict())?;
    if preview.truncated {
        return Err(conflict());
    }
    serde_json::from_slice(&preview.data).map_err(|_| conflict())
}
fn verify_files(roots: &NamedRoots, prefix: &str, receipt: &Receipt) -> Result<u64, ToolError> {
    let entries = roots
        .snapshot_workspace_tree(&format!("{prefix}/package"))
        .map_err(|_| conflict())?;
    let (digest, size) = inventory_digest(&entries)?;
    if digest != receipt.content_digest || size != receipt.unpacked_size {
        return Err(conflict());
    }
    Ok(size)
}
fn inventory_digest(entries: &[TreeEntry]) -> Result<(String, u64), ToolError> {
    let mut canonical = Sha256::new();
    canonical.update(b"antnest-skill-manifest-v1\0");
    let mut size = 0u64;
    let mut expected_dirs = BTreeSet::new();
    let mut actual_dirs = BTreeSet::new();
    let mut files = entries
        .iter()
        .filter(|entry| entry.contents.is_some())
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    if files.is_empty() || files.len() > 256 {
        return Err(conflict());
    }
    for file in files {
        let data = file.contents.as_ref().expect("file inventory");
        size = size.saturating_add(data.len() as u64);
        canonical.update((file.path.len() as u32).to_be_bytes());
        canonical.update(file.path.as_bytes());
        canonical.update((data.len() as u64).to_be_bytes());
        canonical.update(Sha256::digest(data));
        canonical.update([u8::from(file.executable)]);
        let mut path = file.path.as_str();
        while let Some((parent, _)) = path.rsplit_once('/') {
            expected_dirs.insert(parent);
            path = parent;
        }
    }
    for entry in entries {
        if entry.contents.is_none() {
            actual_dirs.insert(entry.path.as_str());
        }
    }
    if expected_dirs != actual_dirs || size > 32 * 1024 * 1024 {
        return Err(conflict());
    }
    Ok((format!("sha256:{}", hex(&canonical.finalize())), size))
}
pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        })
}
fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
}
fn valid_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn conflict() -> ToolError {
    ToolError::invalid_params("Temporary Skill identity or retained content differs")
}
fn limit() -> ToolError {
    ToolError::new(
        ToolErrorCode::SkillStorageFull,
        "Temporary Skill Run quota exceeded",
    )
}
