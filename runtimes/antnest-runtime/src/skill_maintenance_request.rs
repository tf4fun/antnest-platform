// Strict parsing for the private, signed Runtime maintenance boundary.
#![allow(dead_code)]

use axum::body::Bytes;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::stream;
use multer::{Constraints, Multipart, SizeLimit};
use serde::Deserialize;
use serde_json::Value;

use crate::skill_candidate::{
    CandidateCancelRequest, CandidateCheckRequest, CandidateCommitRequest, CandidateObserveRequest,
    CandidatePrepareRequest, CandidateReleaseRequest, StorageClass,
};
use crate::skill_maintenance_auth::MaintenanceTicket;
use crate::skill_package_zip::{SkillPackage, validate_skill_zip};

const MAX_CONTROL_BYTES: usize = 16 * 1024;
const MAX_PREPARE_BYTES: usize = 8 * 1024 * 1024 + 8 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PrepareRequest {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
    pub(crate) candidate_id: String,
    package_path: String,
    expected_base_digest: Value,
    target_digest: String,
    artifact_digest: String,
    package_rules_version: u8,
}

#[derive(Debug)]
pub(crate) struct PreparedCandidate {
    pub(crate) metadata: PrepareRequest,
    pub(crate) package: SkillPackage,
    artifact: Bytes,
}

impl PreparedCandidate {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> CandidatePrepareRequest {
        CandidatePrepareRequest {
            agent_id: ticket.agent_id.clone(),
            generation: ticket.generation,
            execution_id: ticket.execution_id.clone(),
            job_id: self.metadata.job_id,
            candidate_id: self.metadata.candidate_id,
            request_id: self.metadata.request_id,
            package_path: self.metadata.package_path,
            expected_base_digest: self.metadata.expected_base_digest,
            artifact_digest: self.metadata.artifact_digest,
            target_digest: self.metadata.target_digest,
            artifact_base64: STANDARD.encode(self.artifact),
        }
    }
}

pub(crate) async fn parse_prepare_request(
    content_type: &str,
    body: Bytes,
    ticket: &MaintenanceTicket,
) -> Result<PreparedCandidate, &'static str> {
    if ticket.action != "prepare" || body.len() > MAX_PREPARE_BYTES {
        return Err("invalid_request");
    }
    let boundary = multer::parse_boundary(content_type).map_err(|_| "invalid_request")?;
    if !body.starts_with(format!("--{boundary}\r\n").as_bytes()) {
        return Err("invalid_request");
    }
    let ending = format!("\r\n--{boundary}--");
    if !body.ends_with(ending.as_bytes()) && !body.ends_with(format!("{ending}\r\n").as_bytes()) {
        return Err("invalid_request");
    }
    let constraints = Constraints::new()
        .allowed_fields(vec!["metadata", "artifact"])
        .size_limit(
            SizeLimit::new()
                .whole_stream(MAX_PREPARE_BYTES as u64)
                .per_field(8 * 1024 * 1024)
                .for_field("metadata", 4 * 1024),
        );
    let stream = stream::once(async move { Ok::<_, std::io::Error>(body) });
    let mut multipart = Multipart::with_constraints(stream, boundary, constraints);
    let mut metadata = None;
    let mut artifact = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| "invalid_request")?
    {
        let name = field.name().ok_or("invalid_request")?.to_owned();
        let contents = field.bytes().await.map_err(|_| "invalid_request")?;
        match name.as_str() {
            "metadata" if metadata.is_none() => metadata = Some(contents),
            "artifact" if artifact.is_none() => artifact = Some(contents),
            _ => return Err("invalid_request"),
        }
    }
    let metadata = metadata.ok_or("invalid_request")?;
    let request: PrepareRequest =
        serde_json::from_slice(&metadata).map_err(|_| "invalid_request")?;
    check_binding(
        &request.action,
        &request.request_id,
        &request.job_id,
        request.generation,
        "prepare",
        ticket,
    )?;
    if !valid_id(&request.candidate_id)
        || !valid_package_path(&request.package_path)
        || !valid_nullable_digest(&request.expected_base_digest)
        || !valid_digest(&request.target_digest)
        || !valid_digest(&request.artifact_digest)
        || request.package_rules_version != 1
    {
        return Err("invalid_request");
    }
    let artifact = artifact.ok_or("invalid_request")?;
    let package = validate_skill_zip(&artifact)?;
    if request.package_path.rsplit('/').next() != Some(package.name.as_str())
        || request.target_digest != package.content_digest
        || request.artifact_digest != package.artifact_digest
    {
        return Err("request_conflict");
    }
    Ok(PreparedCandidate {
        metadata: request,
        package,
        artifact,
    })
}

#[derive(Debug)]
pub(crate) enum ControlRequest {
    Check(CheckRequest),
    Commit(CommitRequest),
    Observe(ObserveRequest),
    Cancel(CancelRequest),
    Release(ReleaseRequest),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CheckRequest {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
    candidate_id: String,
    package_path: String,
    target_digest: String,
    package_rules_version: u8,
}

impl CheckRequest {
    pub(crate) fn into_executor_request(self, ticket: &MaintenanceTicket) -> CandidateCheckRequest {
        CandidateCheckRequest {
            agent_id: ticket.agent_id.clone(),
            generation: ticket.generation,
            execution_id: ticket.execution_id.clone(),
            job_id: self.job_id,
            candidate_id: self.candidate_id,
            request_id: self.request_id,
            package_path: self.package_path,
            target_digest: self.target_digest,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CommitRequest {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
    candidate_id: String,
    package_path: String,
    expected_base_digest: Value,
    target_digest: String,
}

impl CommitRequest {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> CandidateCommitRequest {
        CandidateCommitRequest {
            agent_id: ticket.agent_id.clone(),
            generation: ticket.generation,
            execution_id: ticket.execution_id.clone(),
            job_id: self.job_id,
            candidate_id: self.candidate_id,
            request_id: self.request_id,
            package_path: self.package_path,
            expected_base_digest: self.expected_base_digest.as_str().map(str::to_owned),
            target_digest: self.target_digest,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ObserveRequest {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
    effect_request_id: String,
    expected_target_digest: Value,
}

impl ObserveRequest {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> CandidateObserveRequest {
        CandidateObserveRequest {
            agent_id: ticket.agent_id.clone(),
            generation: ticket.generation,
            execution_id: ticket.execution_id.clone(),
            job_id: self.job_id,
            request_id: self.request_id,
            effect_request_id: self.effect_request_id,
            expected_target_digest: self.expected_target_digest.as_str().map(str::to_owned),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CancelRequest {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
}

impl CancelRequest {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> CandidateCancelRequest {
        CandidateCancelRequest {
            agent_id: ticket.agent_id.clone(),
            generation: ticket.generation,
            execution_id: ticket.execution_id.clone(),
            job_id: self.job_id,
            request_id: self.request_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReleaseRequest {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
    storage_class: StorageClass,
    storage_key: String,
    package_path: String,
    expected_digest: String,
}

impl ReleaseRequest {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> CandidateReleaseRequest {
        CandidateReleaseRequest {
            agent_id: ticket.agent_id.clone(),
            generation: ticket.generation,
            execution_id: ticket.execution_id.clone(),
            job_id: self.job_id,
            request_id: self.request_id,
            storage_class: self.storage_class,
            storage_key: self.storage_key,
            package_path: self.package_path,
            expected_digest: self.expected_digest,
        }
    }
}

pub(crate) fn parse_control_request(
    action: &str,
    body: &[u8],
    ticket: &MaintenanceTicket,
) -> Result<ControlRequest, &'static str> {
    if body.len() > MAX_CONTROL_BYTES || body.is_empty() || action != ticket.action {
        return Err("invalid_request");
    }
    macro_rules! parse {
        ($ty:ty, $variant:ident, $validate:expr) => {{
            let request: $ty = serde_json::from_slice(body).map_err(|_| "invalid_request")?;
            check_binding(
                &request.action,
                &request.request_id,
                &request.job_id,
                request.generation,
                action,
                ticket,
            )?;
            $validate(&request)?;
            Ok(ControlRequest::$variant(request))
        }};
    }
    match action {
        "check" => parse!(CheckRequest, Check, |value: &CheckRequest| {
            if !valid_id(&value.candidate_id)
                || !valid_package_path(&value.package_path)
                || !valid_digest(&value.target_digest)
                || value.package_rules_version != 1
            {
                return Err("invalid_request");
            }
            Ok(())
        }),
        "commit" => parse!(CommitRequest, Commit, |value: &CommitRequest| {
            if !valid_id(&value.candidate_id)
                || !valid_package_path(&value.package_path)
                || !valid_nullable_digest(&value.expected_base_digest)
                || !valid_digest(&value.target_digest)
            {
                return Err("invalid_request");
            }
            Ok(())
        }),
        "observe" => parse!(ObserveRequest, Observe, |value: &ObserveRequest| {
            if !valid_request_id(&value.effect_request_id)
                || !valid_nullable_digest(&value.expected_target_digest)
            {
                return Err("invalid_request");
            }
            Ok(())
        }),
        "cancel" => parse!(CancelRequest, Cancel, |_value: &CancelRequest| Ok::<
            (),
            &'static str,
        >(())),
        "release" => parse!(ReleaseRequest, Release, |value: &ReleaseRequest| {
            if value.storage_key.len() != 64
                || !value
                    .storage_key
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                || !valid_package_path(&value.package_path)
                || !valid_digest(&value.expected_digest)
            {
                return Err("invalid_request");
            }
            Ok(())
        }),
        _ => Err("invalid_request"),
    }
}

fn check_binding(
    actual_action: &str,
    request_id: &str,
    job_id: &str,
    generation: u64,
    expected_action: &str,
    ticket: &MaintenanceTicket,
) -> Result<(), &'static str> {
    if actual_action != expected_action
        || request_id != ticket.request_id
        || job_id != ticket.job_id
        || generation != ticket.generation
        || generation == 0
        || generation > 9_007_199_254_740_991
        || !valid_request_id(request_id)
        || !valid_id(job_id)
    {
        return Err("request_conflict");
    }
    Ok(())
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

fn valid_nullable_digest(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(valid_digest)
}

fn valid_package_path(value: &str) -> bool {
    if value.len() > 96 {
        return false;
    }
    let Some(name) = value.strip_prefix(".antnest/skills/") else {
        return false;
    };
    !name.is_empty()
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
