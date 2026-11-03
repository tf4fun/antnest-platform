pub const ADDRESS_POOL_EXHAUSTED: &str = "address_pool_exhausted";
pub const AGENT_NETWORK_NOT_FOUND: &str = "agent_network_not_found";
pub const AGENT_NETWORK_UNAVAILABLE: &str = "agent_network_unavailable";
pub const ATTACHMENT_OPEN: &str = "attachment_open";
pub const CALLER_NOT_ALLOWED: &str = "caller_not_allowed";
pub const CLEANUP_FAILED: &str = "cleanup_failed";
pub const CONTROL_PLANE_UNAVAILABLE: &str = "control_plane_unavailable";
pub const INTERNAL: &str = "internal";
pub const INVALID_REQUEST: &str = "invalid_request";
pub const METHOD_NOT_ALLOWED: &str = "method_not_allowed";
pub const OPERATION_FAILED: &str = "operation_failed";
pub const POLICY_REVISION_CONFLICT: &str = "policy_revision_conflict";
pub const POLICY_REVISION_NOT_FOUND: &str = "policy_revision_not_found";
pub const RESOURCE_VERSION_CONFLICT: &str = "resource_version_conflict";
pub const ROUTE_NOT_FOUND: &str = "route_not_found";
pub const SERVICE_NOT_READY: &str = "service_not_ready";
pub const SERVICE_UNAUTHENTICATED: &str = "service_unauthenticated";
pub const TUNNEL_KEY_CONFLICT: &str = "tunnel_key_conflict";
pub const TUNNEL_KEY_UNAVAILABLE: &str = "tunnel_key_unavailable";
pub const UNSUPPORTED_MEDIA_TYPE: &str = "unsupported_media_type";

pub struct ErrorMetadata {
    pub category: &'static str,
    pub http_status: u16,
    pub retryable: bool,
}

pub fn metadata(code: &str) -> Option<ErrorMetadata> {
    match code {
        "address_pool_exhausted" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "agent_network_not_found" => Some(ErrorMetadata {
            category: "not_found",
            http_status: 404,
            retryable: false,
        }),
        "agent_network_unavailable" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "attachment_open" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "caller_not_allowed" => Some(ErrorMetadata {
            category: "forbidden",
            http_status: 403,
            retryable: false,
        }),
        "cleanup_failed" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "control_plane_unavailable" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "internal" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "invalid_request" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "method_not_allowed" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 405,
            retryable: false,
        }),
        "operation_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "policy_revision_conflict" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "policy_revision_not_found" => Some(ErrorMetadata {
            category: "not_found",
            http_status: 404,
            retryable: false,
        }),
        "resource_version_conflict" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "route_not_found" => Some(ErrorMetadata {
            category: "not_found",
            http_status: 404,
            retryable: false,
        }),
        "service_not_ready" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "service_unauthenticated" => Some(ErrorMetadata {
            category: "unauthenticated",
            http_status: 401,
            retryable: false,
        }),
        "tunnel_key_conflict" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "tunnel_key_unavailable" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "unsupported_media_type" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 415,
            retryable: false,
        }),
        _ => None,
    }
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn generated_request_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "gen-{:x}-{:x}",
        nanos,
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn envelope(
    code: &str,
    message: &str,
    request_id: &str,
    retryable: bool,
) -> serde_json::Value {
    let (code, category, message, retryable) = match metadata(code) {
        Some(meta) => (code, meta.category, message.to_owned(), retryable),
        None => (
            INTERNAL,
            "internal",
            "Internal service error".to_owned(),
            false,
        ),
    };
    let request_id = if valid_request_id(request_id) {
        request_id.to_owned()
    } else {
        generated_request_id()
    };
    serde_json::json!({
        "code": code,
        "category": category,
        "message": message,
        "retryable": retryable,
        "request_id": request_id,
    })
}
