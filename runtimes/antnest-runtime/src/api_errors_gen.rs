pub const ATOMIC_SKILL_REPLACE_UNSUPPORTED: &str = "atomic_skill_replace_unsupported";
pub const BODY_TIMED_OUT: &str = "body_timed_out";
pub const BODY_TOO_LARGE: &str = "body_too_large";
pub const CALLER_NOT_ALLOWED: &str = "caller_not_allowed";
pub const CANCELED: &str = "canceled";
pub const CHILD_PROCESS_CONTAINMENT_UNPROVEN: &str = "child_process_containment_unproven";
pub const CLOCK_UNAVAILABLE: &str = "clock_unavailable";
pub const CONTENT_NOT_UTF8: &str = "content_not_utf8";
pub const EDIT_FAILED: &str = "edit_failed";
pub const EDIT_READ_FAILED: &str = "edit_read_failed";
pub const ENCODE_RESULT_FAILED: &str = "encode_result_failed";
pub const HOST_NOT_ALLOWED: &str = "host_not_allowed";
pub const INTERNAL: &str = "internal";
pub const INVALID_CONTENT_TYPE: &str = "invalid_content_type";
pub const INVALID_PARAMS: &str = "invalid_params";
pub const INVALID_PATH: &str = "invalid_path";
pub const INVALID_REQUEST: &str = "invalid_request";
pub const LIMIT_EXCEEDED: &str = "limit_exceeded";
pub const MAINTENANCE_DISABLED: &str = "maintenance_disabled";
pub const MAINTENANCE_UNAUTHORIZED: &str = "maintenance_unauthorized";
pub const MAINTENANCE_UNAVAILABLE: &str = "maintenance_unavailable";
pub const NOT_FOUND: &str = "not_found";
pub const OLD_STRING_NOT_FOUND: &str = "old_string_not_found";
pub const OLD_STRING_NOT_UNIQUE: &str = "old_string_not_unique";
pub const OUTCOME_UNKNOWN: &str = "outcome_unknown";
pub const OUTPUT_CAPTURE_FAILED: &str = "output_capture_failed";
pub const READ_FAILED: &str = "read_failed";
pub const REQUEST_CONFLICT: &str = "request_conflict";
pub const RESULT_TOO_LARGE: &str = "result_too_large";
pub const RUN_CLOSED: &str = "run_closed";
pub const RUNTIME_BUSY: &str = "runtime_busy";
pub const RUNTIME_EXECUTION_MISMATCH: &str = "runtime_execution_mismatch";
pub const RUNTIME_FAILED: &str = "runtime_failed";
pub const RUNTIME_UNAUTHORIZED: &str = "runtime_unauthorized";
pub const RUNTIME_UNAVAILABLE: &str = "runtime_unavailable";
pub const SERVICE_UNAUTHENTICATED: &str = "service_unauthenticated";
pub const SKILL_BACKGROUND_TASK_RUNNING: &str = "skill_background_task_running";
pub const SKILL_MANAGED_CALL_IN_FLIGHT: &str = "skill_managed_call_in_flight";
pub const SKILL_STORAGE_FULL: &str = "skill_storage_full";
pub const SKILL_WRITERS_UNKNOWN: &str = "skill_writers_unknown";
pub const SPAWN_FAILED: &str = "spawn_failed";
pub const TEMPORARY_BACKGROUND_NOT_SUPPORTED: &str = "temporary_background_not_supported";
pub const TEMPORARY_DISABLED: &str = "temporary_disabled";
pub const TEMPORARY_RUN_CLOSED: &str = "temporary_run_closed";
pub const TEMPORARY_SCOPE_BUSY: &str = "temporary_scope_busy";
pub const TEMPORARY_UNAUTHORIZED: &str = "temporary_unauthorized";
pub const TEMPORARY_UNAVAILABLE: &str = "temporary_unavailable";
pub const TIMEOUT: &str = "timeout";
pub const UNKNOWN_ACTION: &str = "unknown_action";
pub const UNSUPPORTED_MEDIA_TYPE: &str = "unsupported_media_type";
pub const WAIT_FAILED: &str = "wait_failed";
pub const WRITE_FAILED: &str = "write_failed";

pub struct ErrorMetadata {
    pub category: &'static str,
    pub http_status: u16,
    pub retryable: bool,
}

pub fn metadata(code: &str) -> Option<ErrorMetadata> {
    match code {
        "atomic_skill_replace_unsupported" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "body_timed_out" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 408,
            retryable: false,
        }),
        "body_too_large" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 413,
            retryable: false,
        }),
        "caller_not_allowed" => Some(ErrorMetadata {
            category: "forbidden",
            http_status: 403,
            retryable: false,
        }),
        "canceled" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 499,
            retryable: false,
        }),
        "child_process_containment_unproven" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "clock_unavailable" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "content_not_utf8" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "edit_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "edit_read_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "encode_result_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "host_not_allowed" => Some(ErrorMetadata {
            category: "forbidden",
            http_status: 403,
            retryable: false,
        }),
        "internal" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "invalid_content_type" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 415,
            retryable: false,
        }),
        "invalid_params" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "invalid_path" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "invalid_request" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "limit_exceeded" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 413,
            retryable: false,
        }),
        "maintenance_disabled" => Some(ErrorMetadata {
            category: "forbidden",
            http_status: 403,
            retryable: false,
        }),
        "maintenance_unauthorized" => Some(ErrorMetadata {
            category: "unauthenticated",
            http_status: 401,
            retryable: false,
        }),
        "maintenance_unavailable" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "not_found" => Some(ErrorMetadata {
            category: "not_found",
            http_status: 404,
            retryable: false,
        }),
        "old_string_not_found" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "old_string_not_unique" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "outcome_unknown" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "output_capture_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "read_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "request_conflict" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "result_too_large" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 413,
            retryable: false,
        }),
        "run_closed" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "runtime_busy" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "runtime_execution_mismatch" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "runtime_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "runtime_unauthorized" => Some(ErrorMetadata {
            category: "unauthenticated",
            http_status: 401,
            retryable: false,
        }),
        "runtime_unavailable" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "service_unauthenticated" => Some(ErrorMetadata {
            category: "unauthenticated",
            http_status: 401,
            retryable: false,
        }),
        "skill_background_task_running" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "skill_managed_call_in_flight" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "skill_storage_full" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "skill_writers_unknown" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "spawn_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "temporary_background_not_supported" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 400,
            retryable: false,
        }),
        "temporary_disabled" => Some(ErrorMetadata {
            category: "forbidden",
            http_status: 403,
            retryable: false,
        }),
        "temporary_run_closed" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "temporary_scope_busy" => Some(ErrorMetadata {
            category: "conflict",
            http_status: 409,
            retryable: false,
        }),
        "temporary_unauthorized" => Some(ErrorMetadata {
            category: "unauthenticated",
            http_status: 401,
            retryable: false,
        }),
        "temporary_unavailable" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 503,
            retryable: true,
        }),
        "timeout" => Some(ErrorMetadata {
            category: "unavailable",
            http_status: 504,
            retryable: true,
        }),
        "unknown_action" => Some(ErrorMetadata {
            category: "not_found",
            http_status: 404,
            retryable: false,
        }),
        "unsupported_media_type" => Some(ErrorMetadata {
            category: "invalid_request",
            http_status: 415,
            retryable: false,
        }),
        "wait_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
            retryable: false,
        }),
        "write_failed" => Some(ErrorMetadata {
            category: "internal",
            http_status: 500,
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
