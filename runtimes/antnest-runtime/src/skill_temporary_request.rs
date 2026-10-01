use crate::skill_maintenance_auth::MaintenanceTicket;
use crate::skill_package_zip::validate_skill_zip;
use crate::skill_temporary::{TemporaryInstallRequest, TemporaryReleaseRequest, valid_id};
use axum::body::Bytes;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::stream;
use multer::{Constraints, Multipart, SizeLimit};
use serde::Deserialize;

pub(crate) const MAX_TEMPORARY_INSTALL_BYTES: usize = 8 * 1024 * 1024 + 8 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallMetadata {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
    content_digest: String,
    artifact_digest: String,
    package_rules_version: u8,
}
pub(crate) struct PreparedTemporary {
    metadata: InstallMetadata,
    artifact: Bytes,
}
impl PreparedTemporary {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> TemporaryInstallRequest {
        TemporaryInstallRequest {
            agent_id: ticket.agent_id.clone(),
            execution_id: ticket.execution_id.clone(),
            job_id: self.metadata.job_id,
            request_id: self.metadata.request_id,
            content_digest: self.metadata.content_digest,
            artifact_digest: self.metadata.artifact_digest,
            artifact_base64: STANDARD.encode(self.artifact),
        }
    }
}
pub(crate) async fn parse_temporary_install(
    content_type: &str,
    body: Bytes,
    ticket: &MaintenanceTicket,
) -> Result<PreparedTemporary, &'static str> {
    if body.len() > MAX_TEMPORARY_INSTALL_BYTES || ticket.action != "temporary_install" {
        return Err("invalid_request");
    }
    let boundary = multer::parse_boundary(content_type).map_err(|_| "invalid_request")?;
    let ending = format!("\r\n--{boundary}--");
    if !body.starts_with(format!("--{boundary}\r\n").as_bytes())
        || !(body.ends_with(ending.as_bytes())
            || body.ends_with(format!("{ending}\r\n").as_bytes()))
    {
        return Err("invalid_request");
    }
    let constraints = Constraints::new()
        .allowed_fields(vec!["metadata", "artifact"])
        .size_limit(
            SizeLimit::new()
                .whole_stream(MAX_TEMPORARY_INSTALL_BYTES as u64)
                .per_field(8 * 1024 * 1024)
                .for_field("metadata", 4096),
        );
    let mut multipart = Multipart::with_constraints(
        stream::once(async move { Ok::<_, std::io::Error>(body) }),
        boundary,
        constraints,
    );
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
    let metadata: InstallMetadata = serde_json::from_slice(&metadata.ok_or("invalid_request")?)
        .map_err(|_| "invalid_request")?;
    binding(
        &metadata.action,
        &metadata.request_id,
        &metadata.job_id,
        metadata.generation,
        "temporary_install",
        ticket,
    )?;
    if metadata.package_rules_version != 1 {
        return Err("invalid_request");
    }
    let artifact = artifact.ok_or("invalid_request")?;
    let package = validate_skill_zip(&artifact).map_err(|_| "invalid_request")?;
    if metadata.content_digest != package.content_digest
        || metadata.artifact_digest != package.artifact_digest
    {
        return Err("request_conflict");
    }
    Ok(PreparedTemporary { metadata, artifact })
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReleaseMetadata {
    action: String,
    request_id: String,
    job_id: String,
    generation: u64,
}
impl ReleaseMetadata {
    pub(crate) fn into_executor_request(
        self,
        ticket: &MaintenanceTicket,
    ) -> TemporaryReleaseRequest {
        TemporaryReleaseRequest {
            agent_id: ticket.agent_id.clone(),
            execution_id: ticket.execution_id.clone(),
            job_id: self.job_id,
        }
    }
}
pub(crate) fn parse_temporary_release(
    body: &[u8],
    ticket: &MaintenanceTicket,
) -> Result<ReleaseMetadata, &'static str> {
    if body.len() > 4096 {
        return Err("invalid_request");
    }
    let metadata: ReleaseMetadata = serde_json::from_slice(body).map_err(|_| "invalid_request")?;
    binding(
        &metadata.action,
        &metadata.request_id,
        &metadata.job_id,
        metadata.generation,
        "temporary_release",
        ticket,
    )?;
    Ok(metadata)
}
fn binding(
    action: &str,
    request: &str,
    run: &str,
    generation: u64,
    expected: &str,
    ticket: &MaintenanceTicket,
) -> Result<(), &'static str> {
    if action != expected
        || ticket.action != expected
        || request != ticket.request_id
        || run != ticket.job_id
        || generation != 1
        || ticket.generation != 1
        || !valid_id(run)
        || !valid_id(request)
    {
        return Err("invalid_request");
    }
    Ok(())
}
