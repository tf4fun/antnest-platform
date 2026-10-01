use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::spec::{RuntimeIdentity, SkillMaintenanceVerifier};

const AUTH_PREFIX: &str = "AntnestMaintenance ";
const SIGNING_DOMAIN: &[u8] = b"antnest-skill-maintenance-v1\n";
const MAX_TOKEN_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MaintenanceAuthError {
    Disabled,
    Unauthorized,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MaintenanceTicket {
    pub(crate) organization_id: String,
    pub(crate) agent_id: String,
    pub(crate) execution_id: String,
    pub(crate) job_id: String,
    pub(crate) generation: u64,
    pub(crate) action: String,
    pub(crate) request_id: String,
    pub(crate) body_sha256: String,
    pub(crate) issued_at: u64,
    pub(crate) expires_at: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketHeader {
    version: u8,
    algorithm: String,
    kid: String,
}

pub(crate) fn verify_maintenance_ticket(
    authorization: &str,
    body: &[u8],
    action: &str,
    identity: &RuntimeIdentity,
    execution_id: &str,
    verifiers: &[SkillMaintenanceVerifier],
    now_epoch: u64,
) -> Result<MaintenanceTicket, MaintenanceAuthError> {
    if verifiers.is_empty() {
        return Err(MaintenanceAuthError::Disabled);
    }
    let token = authorization
        .strip_prefix(AUTH_PREFIX)
        .filter(|value| value.len() <= MAX_TOKEN_BYTES)
        .ok_or(MaintenanceAuthError::Unauthorized)?;
    let mut parts = token.split('.');
    let (Some(encoded_header), Some(encoded_payload), Some(encoded_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(MaintenanceAuthError::Unauthorized);
    };
    let header: TicketHeader = serde_json::from_slice(&decode_canonical(encoded_header)?)
        .map_err(|_| MaintenanceAuthError::Unauthorized)?;
    if header.version != 1 || header.algorithm != "Ed25519" {
        return Err(MaintenanceAuthError::Unauthorized);
    }
    let verifier = verifiers
        .iter()
        .find(|key| key.kid() == header.kid)
        .ok_or(MaintenanceAuthError::Unauthorized)?;
    let payload_bytes = decode_canonical(encoded_payload)?;
    let signature = decode_canonical(encoded_signature)?;
    if signature.len() != 64 {
        return Err(MaintenanceAuthError::Unauthorized);
    }
    let mut signed =
        Vec::with_capacity(SIGNING_DOMAIN.len() + encoded_header.len() + encoded_payload.len() + 1);
    signed.extend_from_slice(SIGNING_DOMAIN);
    signed.extend_from_slice(encoded_header.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(encoded_payload.as_bytes());
    UnparsedPublicKey::new(&ED25519, verifier.public_key())
        .verify(&signed, &signature)
        .map_err(|_| MaintenanceAuthError::Unauthorized)?;
    let ticket: MaintenanceTicket =
        serde_json::from_slice(&payload_bytes).map_err(|_| MaintenanceAuthError::Unauthorized)?;
    if !valid_identity_id(&ticket.organization_id)
        || !valid_identity_id(&ticket.agent_id)
        || ticket.agent_id != identity.agent_id()
        || !valid_opaque_id(&ticket.execution_id, 200)
        || ticket.execution_id != execution_id
        || !valid_opaque_id(&ticket.job_id, 200)
        || !valid_opaque_id(&ticket.request_id, 128)
        || ticket.generation == 0
        || ticket.action != action
        || ticket.expires_at <= ticket.issued_at
        || ticket.expires_at - ticket.issued_at > 60
        || ticket.issued_at > now_epoch.saturating_add(30)
        || now_epoch > ticket.expires_at.saturating_add(30)
        || ticket.body_sha256 != sha256_label(body)
    {
        return Err(MaintenanceAuthError::Unauthorized);
    }
    Ok(ticket)
}

fn decode_canonical(encoded: &str) -> Result<Vec<u8>, MaintenanceAuthError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| MaintenanceAuthError::Unauthorized)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        return Err(MaintenanceAuthError::Unauthorized);
    }
    Ok(decoded)
}

fn valid_identity_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'.' | b'-'))
        })
}

fn valid_opaque_id(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'/' && byte != b'\\')
}

fn sha256_label(body: &[u8]) -> String {
    let mut result = String::with_capacity(71);
    result.push_str("sha256:");
    for byte in Sha256::digest(body) {
        use std::fmt::Write as _;
        write!(result, "{byte:02x}").expect("writing to String is infallible");
    }
    result
}
