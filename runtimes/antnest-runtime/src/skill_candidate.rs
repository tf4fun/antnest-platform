use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::roots::{NamedRoot, NamedRoots, TreeFile, TreeInstallMode};
use crate::skill_package_manifest::validate_skill_manifest;
use crate::skill_package_zip::validate_skill_zip;
use crate::tool_error::{ToolError, ToolErrorCode};

const CANDIDATE_PARENT: &str = ".antnest/skill-learning/candidates";
const HIDDEN_STORAGE_LIMIT: u64 = 256 * 1024 * 1024;

fn ensure_hidden_capacity(roots: &NamedRoots, added: u64) -> Result<(), ToolError> {
    if added > HIDDEN_STORAGE_LIMIT {
        return Err(ToolError::new(
            ToolErrorCode::SkillStorageFull,
            "hidden Skill storage is full",
        ));
    }
    let available = HIDDEN_STORAGE_LIMIT - added;
    let used = roots
        .hidden_skill_storage_bytes(available)
        .map_err(|error| ToolError::new(ToolErrorCode::WriteFailed, error))?;
    if used > available {
        return Err(ToolError::new(
            ToolErrorCode::SkillStorageFull,
            "hidden Skill storage is full",
        ));
    }
    Ok(())
}

fn snapshot_bytes(entries: &[crate::roots::TreeEntry]) -> u64 {
    entries
        .iter()
        .filter_map(|entry| entry.contents.as_ref())
        .map(|contents| contents.len() as u64)
        .fold(0, u64::saturating_add)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidatePrepareRequest {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) candidate_id: String,
    pub(crate) request_id: String,
    pub(crate) package_path: String,
    pub(crate) expected_base_digest: Value,
    pub(crate) artifact_digest: String,
    pub(crate) target_digest: String,
    pub(crate) artifact_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CandidateRecord {
    agent_id: String,
    generation: u64,
    execution_id: String,
    job_id: String,
    candidate_id: String,
    request_id: String,
    package_path: String,
    expected_base_digest: Option<String>,
    artifact_digest: String,
    target_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidatePrepared {
    pub(crate) candidate_key: String,
    pub(crate) observed_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateCheckRequest {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) candidate_id: String,
    pub(crate) request_id: String,
    pub(crate) package_path: String,
    pub(crate) target_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateChecked {
    pub(crate) observed_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateCommitRequest {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) candidate_id: String,
    pub(crate) request_id: String,
    pub(crate) package_path: String,
    pub(crate) expected_base_digest: Option<String>,
    pub(crate) target_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateCommitted {
    pub(crate) observed_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateObserveRequest {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) request_id: String,
    pub(crate) effect_request_id: String,
    pub(crate) expected_target_digest: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CandidateObservedOutcome {
    Applied,
    Conflict,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateObserved {
    pub(crate) outcome: CandidateObservedOutcome,
    pub(crate) observed_digest: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateCancelRequest {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) request_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateCancelled;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StorageClass {
    Candidate,
}

impl StorageClass {
    fn parent(self) -> &'static str {
        match self {
            Self::Candidate => CANDIDATE_PARENT,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateReleaseRequest {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) request_id: String,
    pub(crate) storage_class: StorageClass,
    pub(crate) storage_key: String,
    pub(crate) package_path: String,
    pub(crate) expected_digest: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CandidateReleased;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReleasePhase {
    Intent,
    Detached,
    Applied,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReleaseRecord {
    agent_id: String,
    generation: u64,
    job_id: String,
    request_id: String,
    storage_class: StorageClass,
    storage_key: String,
    package_path: String,
    expected_digest: String,
    phase: ReleasePhase,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CancellationRecord {
    agent_id: String,
    generation: u64,
    job_id: String,
    request_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EffectPhase {
    Intent,
    Applied,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EffectRecord {
    agent_id: String,
    generation: u64,
    job_id: String,
    request_id: String,
    candidate_id: String,
    package_path: String,
    expected_base_digest: Option<String>,
    target_digest: String,
    initial_execution_id: String,
    phase: EffectPhase,
}

pub(crate) fn commit_candidate(
    roots: &NamedRoots,
    request: CandidateCommitRequest,
) -> Result<CandidateCommitted, ToolError> {
    #[cfg(feature = "skill-maintenance-e2e-gate")]
    let after_install = e2e_gate_after_install;
    #[cfg(not(feature = "skill-maintenance-e2e-gate"))]
    let after_install = || {};
    commit_candidate_with_hook(roots, request, after_install)
}

#[cfg(feature = "skill-maintenance-e2e-gate")]
fn e2e_gate_after_install() {
    use std::time::{Duration, Instant};

    let gate = std::path::Path::new("/workspace/.antnest/skill-learning/e2e-commit-gate");
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

fn commit_candidate_with_hook(
    roots: &NamedRoots,
    request: CandidateCommitRequest,
    after_install: impl FnOnce(),
) -> Result<CandidateCommitted, ToolError> {
    if !valid_id(&request.agent_id)
        || request.generation == 0
        || !valid_id(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_id(&request.candidate_id)
        || !valid_request_id(&request.request_id)
        || !valid_digest(&request.target_digest)
        || request
            .expected_base_digest
            .as_deref()
            .is_some_and(|value| !valid_digest(value))
        || request.expected_base_digest.as_deref() == Some(request.target_digest.as_str())
    {
        return Err(ToolError::invalid_params("invalid Skill commit identity"));
    }
    ensure_generation_open(
        roots,
        &request.agent_id,
        &request.job_id,
        request.generation,
    )?;
    let skill_name = request
        .package_path
        .strip_prefix(".antnest/skills/")
        .filter(|name| valid_skill_name(name))
        .ok_or_else(|| ToolError::invalid_params("invalid managed Skill path"))?;
    let active = request.package_path.as_str();
    let effect_path = format!(
        ".antnest/skill-learning/effects/{}.json",
        effect_key(&request)
    );
    let prior = match roots.read(NamedRoot::Workspace, &effect_path) {
        Ok(receipt) => Some(
            serde_json::from_slice::<EffectRecord>(&receipt.data)
                .map_err(|_| ToolError::invalid_params("Skill effect record is invalid"))?,
        ),
        Err(error) if error.is_not_found() => None,
        Err(_) => {
            return Err(ToolError::invalid_params(
                "Skill effect record is unreadable",
            ));
        }
    };
    if let Some(prior) = &prior
        && (prior.agent_id != request.agent_id
            || prior.generation != request.generation
            || prior.job_id != request.job_id
            || prior.request_id != request.request_id
            || prior.candidate_id != request.candidate_id
            || prior.package_path != request.package_path
            || prior.expected_base_digest != request.expected_base_digest
            || prior.target_digest != request.target_digest)
    {
        return Err(ToolError::invalid_params(
            "Skill effect request conflicts with an existing intent",
        ));
    }
    let current = active_digest(roots, active)?;
    if prior.is_some() && current.as_deref() == Some(request.target_digest.as_str()) {
        return Ok(CandidateCommitted {
            observed_digest: request.target_digest,
        });
    }
    if current != request.expected_base_digest {
        return Err(ToolError::invalid_params(
            "managed Skill base digest has changed",
        ));
    }
    let candidate_key = candidate_key(
        &request.agent_id,
        request.generation,
        &request.execution_id,
        &request.job_id,
        &request.candidate_id,
    );
    let candidate_root = format!("{CANDIDATE_PARENT}/{candidate_key}");
    let receipt = roots
        .read(
            NamedRoot::Workspace,
            &format!("{candidate_root}/receipt.json"),
        )
        .map_err(|_| ToolError::invalid_params("candidate receipt is missing"))?;
    let prepared: CandidateRecord = serde_json::from_slice(&receipt.data)
        .map_err(|_| ToolError::invalid_params("candidate receipt is invalid"))?;
    if prepared.agent_id != request.agent_id
        || prepared.generation != request.generation
        || prepared.execution_id != request.execution_id
        || prepared.job_id != request.job_id
        || prepared.candidate_id != request.candidate_id
        || prepared.package_path != request.package_path
        || prepared.expected_base_digest != request.expected_base_digest
        || prepared.target_digest != request.target_digest
    {
        return Err(ToolError::invalid_params(
            "candidate and commit binding differ",
        ));
    }
    let checked = roots
        .read(
            NamedRoot::Workspace,
            &format!("{candidate_root}/checked.json"),
        )
        .map_err(|_| ToolError::invalid_params("candidate has not passed check"))?;
    if checked.data != receipt.data {
        return Err(ToolError::invalid_params("candidate check is stale"));
    }
    let snapshot = roots
        .snapshot_workspace_tree(&format!("{candidate_root}/package"))
        .map_err(|_| ToolError::invalid_params("candidate inventory is unreadable"))?;
    if digest_snapshot(&snapshot, &request.package_path)? != request.target_digest {
        return Err(ToolError::invalid_params("candidate content has changed"));
    }
    if let Some(base_digest) = &request.expected_base_digest {
        if active_digest(roots, active)?.as_deref() != Some(base_digest.as_str()) {
            return Err(ToolError::invalid_params(
                "managed Skill base changed before activation",
            ));
        }
        let old = roots
            .snapshot_workspace_tree(active)
            .map_err(|_| ToolError::invalid_params("managed Skill base is unreadable"))?;
        ensure_hidden_capacity(
            roots,
            snapshot_bytes(&old).saturating_sub(snapshot_bytes(&snapshot)),
        )?;
    }
    let mut effect = prior.unwrap_or_else(|| EffectRecord {
        agent_id: request.agent_id.clone(),
        generation: request.generation,
        job_id: request.job_id.clone(),
        request_id: request.request_id.clone(),
        candidate_id: request.candidate_id.clone(),
        package_path: request.package_path.clone(),
        expected_base_digest: request.expected_base_digest.clone(),
        target_digest: request.target_digest.clone(),
        initial_execution_id: request.execution_id.clone(),
        phase: EffectPhase::Intent,
    });
    write_effect(roots, &effect_path, &effect)?;
    let mode = if request.expected_base_digest.is_some() {
        TreeInstallMode::Replace
    } else {
        TreeInstallMode::Create
    };
    match roots.install_candidate_tree(&candidate_key, skill_name, mode) {
        Ok(()) => {}
        #[cfg(target_os = "linux")]
        Err(crate::roots::RootError::AtomicSkillReplaceUnsupported(error)) => {
            return Err(ToolError::new(
                ToolErrorCode::AtomicSkillReplaceUnsupported,
                error,
            ));
        }
        Err(error) if error.outcome_unknown() => return Err(ToolError::outcome_unknown(error)),
        Err(error) => return Err(ToolError::new(ToolErrorCode::WriteFailed, error)),
    }
    after_install();
    let observed = active_digest(roots, active).map_err(|error| {
        ToolError::unknown(
            ToolErrorCode::SkillContentChangedDuringActivation,
            error.message,
        )
    })?;
    if observed.as_deref() != Some(request.target_digest.as_str()) {
        return Err(ToolError::unknown(
            ToolErrorCode::SkillContentChangedDuringActivation,
            "managed Skill content changed during activation",
        ));
    }
    effect.phase = EffectPhase::Applied;
    write_effect(roots, &effect_path, &effect)
        .map_err(|error| ToolError::unknown(ToolErrorCode::OutcomeUnknown, error.message))?;
    Ok(CandidateCommitted {
        observed_digest: request.target_digest,
    })
}

pub(crate) fn observe_candidate(
    roots: &NamedRoots,
    request: CandidateObserveRequest,
) -> Result<CandidateObserved, ToolError> {
    if !valid_id(&request.agent_id)
        || request.generation == 0
        || !valid_id(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_request_id(&request.request_id)
        || !valid_request_id(&request.effect_request_id)
        || request
            .expected_target_digest
            .as_deref()
            .is_some_and(|value| !valid_digest(value))
    {
        return Err(ToolError::invalid_params("invalid Skill observe identity"));
    }
    let effect_key = effect_key_for(
        &request.agent_id,
        request.generation,
        &request.job_id,
        &request.effect_request_id,
    );
    let effect_path = format!(".antnest/skill-learning/effects/{effect_key}.json");
    match roots.read(NamedRoot::Workspace, &effect_path) {
        Ok(receipt) => {
            let record = match serde_json::from_slice::<EffectRecord>(&receipt.data) {
                Ok(record) => record,
                Err(_) => return Ok(unknown_observation()),
            };
            observe_commit(roots, &request, record)
        }
        Err(_) => Ok(unknown_observation()),
    }
}

pub(crate) fn release_candidate(
    roots: &NamedRoots,
    request: CandidateReleaseRequest,
) -> Result<CandidateReleased, ToolError> {
    if !valid_id(&request.agent_id)
        || request.generation == 0
        || !valid_id(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_request_id(&request.request_id)
        || request.storage_key.len() != 64
        || !request
            .storage_key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !valid_digest(&request.expected_digest)
        || !request
            .package_path
            .strip_prefix(".antnest/skills/")
            .is_some_and(valid_skill_name)
    {
        return Err(ToolError::invalid_params("invalid Skill release identity"));
    }
    let release_key = effect_key_for(
        &request.agent_id,
        request.generation,
        &request.job_id,
        &request.request_id,
    );
    let record_path = format!(".antnest/skill-learning/releases/{release_key}.json");
    let source_path = format!("{}/{}", request.storage_class.parent(), request.storage_key);
    let stage_path = format!(".antnest/skill-learning/release-stage/{release_key}");
    let prior = match roots.read(NamedRoot::Workspace, &record_path) {
        Ok(value) => Some(
            serde_json::from_slice::<ReleaseRecord>(&value.data)
                .map_err(|_| ToolError::invalid_params("Skill release record is invalid"))?,
        ),
        Err(error) if error.is_not_found() => None,
        Err(_) => {
            return Err(ToolError::invalid_params(
                "Skill release record is unreadable",
            ));
        }
    };
    if let Some(prior) = &prior {
        if prior.agent_id != request.agent_id
            || prior.generation != request.generation
            || prior.job_id != request.job_id
            || prior.request_id != request.request_id
            || prior.storage_class != request.storage_class
            || prior.storage_key != request.storage_key
            || prior.package_path != request.package_path
            || prior.expected_digest != request.expected_digest
        {
            return Err(ToolError::invalid_params(
                "Skill release request changed on replay",
            ));
        }
        if prior.phase == ReleasePhase::Applied {
            return Ok(CandidateReleased);
        }
    }
    let source_exists = roots
        .workspace_tree_exists(&source_path)
        .map_err(|error| ToolError::unknown(ToolErrorCode::OutcomeUnknown, error))?;
    let stage_exists = roots
        .workspace_tree_exists(&stage_path)
        .map_err(|error| ToolError::unknown(ToolErrorCode::OutcomeUnknown, error))?;
    if (source_exists && stage_exists)
        || (stage_exists && prior.is_none())
        || (!source_exists
            && !stage_exists
            && prior
                .as_ref()
                .is_none_or(|record| record.phase != ReleasePhase::Detached))
    {
        return Err(ToolError::outcome_unknown(
            "Skill release storage state cannot be proven",
        ));
    }
    let mut record = prior.unwrap_or_else(|| ReleaseRecord {
        agent_id: request.agent_id.clone(),
        generation: request.generation,
        job_id: request.job_id.clone(),
        request_id: request.request_id.clone(),
        storage_class: request.storage_class,
        storage_key: request.storage_key.clone(),
        package_path: request.package_path.clone(),
        expected_digest: request.expected_digest.clone(),
        phase: ReleasePhase::Intent,
    });
    if record.phase == ReleasePhase::Detached && !stage_exists {
        record.phase = ReleasePhase::Applied;
        write_release_record(roots, &record_path, &record)?;
        return Ok(CandidateReleased);
    }
    if !stage_exists {
        verify_release_tree(roots, &source_path, &request)?;
        write_release_record(roots, &record_path, &record)?;
        roots
            .detach_skill_learning_tree(
                request.storage_class.parent(),
                &request.storage_key,
                &release_key,
            )
            .map_err(|error| ToolError::unknown(ToolErrorCode::OutcomeUnknown, error))?;
    }
    verify_release_tree(roots, &stage_path, &request)?;
    record.phase = ReleasePhase::Detached;
    write_release_record(roots, &record_path, &record)?;
    roots
        .remove_detached_skill_learning_tree(&release_key)
        .map_err(|error| ToolError::unknown(ToolErrorCode::OutcomeUnknown, error))?;
    record.phase = ReleasePhase::Applied;
    write_release_record(roots, &record_path, &record)?;
    Ok(CandidateReleased)
}

fn verify_release_tree(
    roots: &NamedRoots,
    root: &str,
    request: &CandidateReleaseRequest,
) -> Result<(), ToolError> {
    if request.storage_class == StorageClass::Candidate {
        let receipt = roots
            .read(NamedRoot::Workspace, &format!("{root}/receipt.json"))
            .map_err(|_| ToolError::invalid_params("candidate receipt is missing"))?;
        let candidate: CandidateRecord = serde_json::from_slice(&receipt.data)
            .map_err(|_| ToolError::invalid_params("candidate receipt is invalid"))?;
        if candidate.agent_id != request.agent_id
            || candidate.package_path != request.package_path
            || candidate.target_digest != request.expected_digest
            || candidate_key(
                &candidate.agent_id,
                candidate.generation,
                &candidate.execution_id,
                &candidate.job_id,
                &candidate.candidate_id,
            ) != request.storage_key
        {
            return Err(ToolError::invalid_params(
                "candidate release binding differs",
            ));
        }
    }
    Ok(())
}

fn write_release_record(
    roots: &NamedRoots,
    path: &str,
    record: &ReleaseRecord,
) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec(record)
        .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?;
    roots
        .write(NamedRoot::Workspace, path, &bytes, false)
        .map(|_| ())
        .map_err(|error| {
            if error.outcome_unknown() {
                ToolError::outcome_unknown(error)
            } else {
                ToolError::new(ToolErrorCode::WriteFailed, error)
            }
        })
}

fn observe_commit(
    roots: &NamedRoots,
    request: &CandidateObserveRequest,
    record: EffectRecord,
) -> Result<CandidateObserved, ToolError> {
    if record.agent_id != request.agent_id
        || record.generation != request.generation
        || record.job_id != request.job_id
        || record.request_id != request.effect_request_id
    {
        return Ok(unknown_observation());
    }
    if Some(record.target_digest.as_str()) != request.expected_target_digest.as_deref() {
        return Err(ToolError::invalid_params(
            "observed Skill target differs from effect intent",
        ));
    }
    let observed = match active_digest(roots, &record.package_path) {
        Ok(value) => value,
        Err(_) => return Ok(unknown_observation()),
    };
    let outcome = if observed.as_deref() == Some(record.target_digest.as_str()) {
        CandidateObservedOutcome::Applied
    } else {
        CandidateObservedOutcome::Conflict
    };
    Ok(CandidateObserved {
        outcome,
        observed_digest: observed,
    })
}

pub(crate) fn cancel_generation(
    roots: &NamedRoots,
    request: CandidateCancelRequest,
) -> Result<CandidateCancelled, ToolError> {
    if !valid_id(&request.agent_id)
        || request.generation == 0
        || !valid_id(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_request_id(&request.request_id)
    {
        return Err(ToolError::invalid_params("invalid Skill cancel identity"));
    }
    let path = cancellation_path(&request.agent_id, &request.job_id, request.generation);
    match roots.read(NamedRoot::Workspace, &path) {
        Ok(record) => {
            let recorded: CancellationRecord = serde_json::from_slice(&record.data)
                .map_err(|_| ToolError::invalid_params("Skill cancellation record is invalid"))?;
            if recorded.agent_id != request.agent_id
                || recorded.job_id != request.job_id
                || recorded.generation != request.generation
            {
                return Err(ToolError::invalid_params(
                    "Skill cancellation record conflicts",
                ));
            }
            return Ok(CandidateCancelled);
        }
        Err(error) if error.is_not_found() => {}
        Err(_) => {
            return Err(ToolError::invalid_params(
                "Skill cancellation state is unreadable",
            ));
        }
    }
    let record = CancellationRecord {
        agent_id: request.agent_id,
        generation: request.generation,
        job_id: request.job_id,
        request_id: request.request_id,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?;
    roots
        .write(NamedRoot::Workspace, &path, &bytes, false)
        .map_err(|error| {
            if error.outcome_unknown() {
                ToolError::outcome_unknown(error)
            } else {
                ToolError::new(ToolErrorCode::WriteFailed, error)
            }
        })?;
    Ok(CandidateCancelled)
}

fn ensure_generation_open(
    roots: &NamedRoots,
    agent_id: &str,
    job_id: &str,
    generation: u64,
) -> Result<(), ToolError> {
    let path = cancellation_path(agent_id, job_id, generation);
    match roots.read(NamedRoot::Workspace, &path) {
        Err(error) if error.is_not_found() => Ok(()),
        _ => Err(ToolError::new(
            ToolErrorCode::SkillGenerationCancelled,
            "Skill maintenance generation is closed",
        )),
    }
}

fn cancellation_path(agent_id: &str, job_id: &str, generation: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"antnest-skill-cancel-v1\0");
    digest.update(generation.to_be_bytes());
    for value in [agent_id, job_id] {
        digest.update((value.len() as u32).to_be_bytes());
        digest.update(value.as_bytes());
    }
    let key = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(".antnest/skill-learning/cancelled/{key}.json")
}

fn unknown_observation() -> CandidateObserved {
    CandidateObserved {
        outcome: CandidateObservedOutcome::Unknown,
        observed_digest: None,
    }
}

fn active_digest(roots: &NamedRoots, path: &str) -> Result<Option<String>, ToolError> {
    match roots.snapshot_workspace_tree(path) {
        Ok(entries) => digest_snapshot(&entries, path).map(Some),
        Err(error) if error.is_not_found() => Ok(None),
        Err(_) => Err(ToolError::invalid_params(
            "managed Skill activity is unreadable",
        )),
    }
}

fn write_effect(roots: &NamedRoots, path: &str, effect: &EffectRecord) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec(effect)
        .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?;
    roots
        .write(NamedRoot::Workspace, path, &bytes, false)
        .map(|_| ())
        .map_err(|error| {
            if error.outcome_unknown() {
                ToolError::outcome_unknown(error)
            } else {
                ToolError::new(ToolErrorCode::WriteFailed, error)
            }
        })
}

fn effect_key(request: &CandidateCommitRequest) -> String {
    effect_key_for(
        &request.agent_id,
        request.generation,
        &request.job_id,
        &request.request_id,
    )
}

fn effect_key_for(agent_id: &str, generation: u64, job_id: &str, request_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"antnest-skill-effect-v1\0");
    digest.update(generation.to_be_bytes());
    for value in [agent_id, job_id, request_id] {
        digest.update((value.len() as u32).to_be_bytes());
        digest.update(value.as_bytes());
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

pub(crate) fn check_candidate(
    roots: &NamedRoots,
    request: CandidateCheckRequest,
) -> Result<CandidateChecked, ToolError> {
    if !valid_id(&request.agent_id)
        || request.generation == 0
        || !valid_id(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_id(&request.candidate_id)
        || !valid_request_id(&request.request_id)
    {
        return Err(ToolError::invalid_params("invalid candidate identity"));
    }
    ensure_generation_open(
        roots,
        &request.agent_id,
        &request.job_id,
        request.generation,
    )?;
    let key = candidate_key(
        &request.agent_id,
        request.generation,
        &request.execution_id,
        &request.job_id,
        &request.candidate_id,
    );
    let root = format!("{CANDIDATE_PARENT}/{key}");
    let receipt = roots
        .read(NamedRoot::Workspace, &format!("{root}/receipt.json"))
        .map_err(|_| ToolError::invalid_params("candidate receipt is missing or unreadable"))?;
    let record: CandidateRecord = serde_json::from_slice(&receipt.data)
        .map_err(|_| ToolError::invalid_params("candidate receipt is invalid"))?;
    if record.agent_id != request.agent_id
        || record.generation != request.generation
        || record.execution_id != request.execution_id
        || record.job_id != request.job_id
        || record.candidate_id != request.candidate_id
        || record.package_path != request.package_path
        || record.target_digest != request.target_digest
    {
        return Err(ToolError::invalid_params("candidate binding has changed"));
    }
    let snapshot = roots
        .snapshot_workspace_tree(&format!("{root}/package"))
        .map_err(|_| ToolError::invalid_params("candidate inventory is unreadable"))?;
    let observed = digest_snapshot(&snapshot, &record.package_path)?;
    if observed != record.target_digest {
        return Err(ToolError::invalid_params("candidate content has changed"));
    }
    let checked_path = format!("{root}/checked.json");
    match roots.read(NamedRoot::Workspace, &checked_path) {
        Ok(existing) if existing.data == receipt.data => {
            return Ok(CandidateChecked {
                observed_digest: observed,
            });
        }
        Ok(_) => return Err(ToolError::invalid_params("candidate check is stale")),
        Err(error) if error.is_not_found() => {}
        Err(_) => return Err(ToolError::invalid_params("candidate check is unreadable")),
    }
    ensure_hidden_capacity(roots, receipt.data.len() as u64)?;
    roots
        .write(NamedRoot::Workspace, &checked_path, &receipt.data, false)
        .map_err(|error| {
            if error.outcome_unknown() {
                ToolError::outcome_unknown(error)
            } else {
                ToolError::new(ToolErrorCode::WriteFailed, error)
            }
        })?;
    Ok(CandidateChecked {
        observed_digest: observed,
    })
}

fn digest_snapshot(
    entries: &[crate::roots::TreeEntry],
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

pub(crate) fn prepare_candidate(
    roots: &NamedRoots,
    request: CandidatePrepareRequest,
) -> Result<CandidatePrepared, ToolError> {
    if !valid_id(&request.agent_id)
        || request.generation == 0
        || !valid_id(&request.execution_id)
        || !valid_id(&request.job_id)
        || !valid_id(&request.candidate_id)
        || !valid_request_id(&request.request_id)
        || !(request.expected_base_digest.is_null()
            || request
                .expected_base_digest
                .as_str()
                .is_some_and(valid_digest))
    {
        return Err(ToolError::invalid_params("invalid candidate identity"));
    }
    ensure_generation_open(
        roots,
        &request.agent_id,
        &request.job_id,
        request.generation,
    )?;
    let artifact = STANDARD
        .decode(&request.artifact_base64)
        .map_err(|_| ToolError::invalid_params("invalid candidate encoding"))?;
    let package = validate_skill_zip(&artifact).map_err(ToolError::invalid_params)?;
    if request.package_path != format!(".antnest/skills/{}", package.name)
        || request.artifact_digest != package.artifact_digest
        || request.target_digest != package.content_digest
    {
        return Err(ToolError::invalid_params(
            "candidate content identity differs",
        ));
    }
    let key = candidate_key(
        &request.agent_id,
        request.generation,
        &request.execution_id,
        &request.job_id,
        &request.candidate_id,
    );
    let record = CandidateRecord {
        agent_id: request.agent_id,
        generation: request.generation,
        execution_id: request.execution_id,
        job_id: request.job_id,
        candidate_id: request.candidate_id,
        request_id: request.request_id,
        package_path: request.package_path,
        expected_base_digest: request.expected_base_digest.as_str().map(str::to_owned),
        artifact_digest: request.artifact_digest,
        target_digest: request.target_digest,
    };
    if roots
        .workspace_tree_exists(&format!("{CANDIDATE_PARENT}/{key}"))
        .map_err(|error| ToolError::new(ToolErrorCode::WriteFailed, error))?
    {
        verify_existing(roots, &key, &record, &package)?;
        return Ok(CandidatePrepared {
            candidate_key: key,
            observed_digest: record.target_digest,
        });
    }
    let record_bytes = serde_json::to_vec(&record)
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
            path: path.as_str(),
            contents: &file.contents,
            executable: file.executable,
        })
        .collect::<Vec<_>>();
    files.push(TreeFile {
        path: "receipt.json",
        contents: &record_bytes,
        executable: false,
    });
    let added = package
        .files
        .iter()
        .map(|file| file.contents.len() as u64)
        .fold(record_bytes.len() as u64, u64::saturating_add);
    ensure_hidden_capacity(roots, added)?;
    match roots.publish_workspace_tree(CANDIDATE_PARENT, &key, &files) {
        Ok(()) => {}
        Err(error) if already_exists(&error) => {
            verify_existing(roots, &key, &record, &package)?;
        }
        Err(error) if error.outcome_unknown() => return Err(ToolError::outcome_unknown(error)),
        Err(error) => return Err(ToolError::new(ToolErrorCode::WriteFailed, error)),
    }
    Ok(CandidatePrepared {
        candidate_key: key,
        observed_digest: record.target_digest,
    })
}

#[cfg(target_os = "linux")]
fn already_exists(error: &crate::roots::RootError) -> bool {
    matches!(error, crate::roots::RootError::System { source, .. }
        if source.kind() == std::io::ErrorKind::AlreadyExists)
}

#[cfg(not(target_os = "linux"))]
fn already_exists(_error: &crate::roots::RootError) -> bool {
    false
}

fn verify_existing(
    roots: &NamedRoots,
    key: &str,
    expected: &CandidateRecord,
    package: &crate::skill_package_zip::SkillPackage,
) -> Result<(), ToolError> {
    let prefix = format!("{CANDIDATE_PARENT}/{key}");
    let receipt = roots
        .read(NamedRoot::Workspace, &format!("{prefix}/receipt.json"))
        .map_err(|_| ToolError::invalid_params("candidate receipt is missing or unreadable"))?;
    let actual: CandidateRecord = serde_json::from_slice(&receipt.data)
        .map_err(|_| ToolError::invalid_params("candidate receipt is invalid"))?;
    if &actual != expected {
        return Err(ToolError::invalid_params(
            "candidate request conflicts with an existing candidate",
        ));
    }
    let entries = roots
        .snapshot_workspace_tree(&format!("{prefix}/package"))
        .map_err(|_| ToolError::invalid_params("candidate inventory is unreadable"))?;
    let mut expected_directories = BTreeSet::new();
    for file in &package.files {
        let mut parent = file.path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            expected_directories.insert(prefix.to_owned());
            parent = prefix;
        }
    }
    if entries.len() != package.files.len() + expected_directories.len() {
        return Err(ToolError::invalid_params("candidate inventory has changed"));
    }
    for entry in entries {
        match entry.contents {
            Some(contents) => {
                let matching = package.files.iter().find(|file| file.path == entry.path);
                if matching.is_none_or(|file| {
                    file.contents != contents || file.executable != entry.executable
                }) {
                    return Err(ToolError::invalid_params("candidate content has changed"));
                }
            }
            None if expected_directories.contains(&entry.path) => {}
            None => return Err(ToolError::invalid_params("candidate inventory has changed")),
        }
    }
    Ok(())
}

fn candidate_key(
    agent_id: &str,
    generation: u64,
    execution_id: &str,
    job_id: &str,
    candidate_id: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"antnest-skill-candidate-v1\0");
    digest.update(generation.to_be_bytes());
    for value in [agent_id, execution_id, job_id, candidate_id] {
        digest.update((value.len() as u32).to_be_bytes());
        digest.update(value.as_bytes());
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::roots::TreeEntry;
    use crate::tool_error::ToolEffectState;

    #[test]
    fn writer_after_atomic_install_yields_unknown_then_observed_conflict() {
        let workspace = tempdir().expect("workspace");
        let skills = tempdir().expect("system Skills");
        let roots = NamedRoots::open(workspace.path(), skills.path()).expect("roots");
        let path = ".antnest/skills/retry-timeouts";
        let manifest = b"---\nname: retry-timeouts\ndescription: Retry safely\n---\n";
        let target_digest = digest_snapshot(
            &[TreeEntry {
                path: "SKILL.md".into(),
                contents: Some(manifest.to_vec()),
                executable: false,
            }],
            path,
        )
        .expect("candidate digest");
        let candidate_key = candidate_key("agent-1", 1, "execution-1", "job-1", "candidate-1");
        let receipt = serde_json::to_vec(&CandidateRecord {
            agent_id: "agent-1".into(),
            generation: 1,
            execution_id: "execution-1".into(),
            job_id: "job-1".into(),
            candidate_id: "candidate-1".into(),
            request_id: "prepare-1".into(),
            package_path: path.into(),
            expected_base_digest: None,
            artifact_digest: target_digest.clone(),
            target_digest: target_digest.clone(),
        })
        .expect("receipt");
        roots
            .publish_workspace_tree(
                CANDIDATE_PARENT,
                &candidate_key,
                &[
                    TreeFile {
                        path: "package/SKILL.md",
                        contents: manifest,
                        executable: false,
                    },
                    TreeFile {
                        path: "receipt.json",
                        contents: &receipt,
                        executable: false,
                    },
                    TreeFile {
                        path: "checked.json",
                        contents: &receipt,
                        executable: false,
                    },
                ],
            )
            .expect("candidate");
        let active = workspace.path().join(path).join("SKILL.md");
        let error = commit_candidate_with_hook(
            &roots,
            CandidateCommitRequest {
                agent_id: "agent-1".into(),
                generation: 1,
                execution_id: "execution-1".into(),
                job_id: "job-1".into(),
                candidate_id: "candidate-1".into(),
                request_id: "commit-1".into(),
                package_path: path.into(),
                expected_base_digest: None,
                target_digest: target_digest.clone(),
            },
            || {
                fs::write(
                    &active,
                    [manifest.as_slice(), b"writer changed content\n"].concat(),
                )
                .expect("external writer")
            },
        )
        .expect_err("changed active package must not report success");
        assert_eq!(
            error.code,
            ToolErrorCode::SkillContentChangedDuringActivation
        );
        assert_eq!(error.effect_state, ToolEffectState::Unknown);
        let observed = observe_candidate(
            &roots,
            CandidateObserveRequest {
                agent_id: "agent-1".into(),
                generation: 1,
                execution_id: "execution-1".into(),
                job_id: "job-1".into(),
                request_id: "observe-1".into(),
                effect_request_id: "commit-1".into(),
                expected_target_digest: Some(target_digest),
            },
        )
        .expect("observe effect");
        assert!(matches!(
            observed.outcome,
            CandidateObservedOutcome::Conflict
        ));
    }
}
