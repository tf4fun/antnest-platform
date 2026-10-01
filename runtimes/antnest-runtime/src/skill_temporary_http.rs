use crate::execution_actor::ExecutionActor;
use crate::mcp::RuntimeStatus;
use crate::skill_maintenance_auth::verify_maintenance_ticket;
use crate::skill_temporary_request::{
    MAX_TEMPORARY_INSTALL_BYTES, parse_temporary_install, parse_temporary_release,
};
use crate::spec::SkillMaintenanceVerifier;
use crate::tool_error::{ToolEffectState, ToolError, ToolErrorCode};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{
        StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::json;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::Instrument as _;

pub(crate) const TEMPORARY_ROUTE: &str = "/internal/skill-temporary/{action}";
#[derive(Clone)]
struct TemporaryHttpState {
    status: RuntimeStatus,
    verifiers: Vec<SkillMaintenanceVerifier>,
    actor: Option<ExecutionActor>,
}
pub(crate) fn temporary_skill_router(
    status: RuntimeStatus,
    verifiers: Vec<SkillMaintenanceVerifier>,
    actor: Option<ExecutionActor>,
) -> Router {
    Router::new()
        .route(TEMPORARY_ROUTE, post(handle))
        .with_state(TemporaryHttpState {
            status,
            verifiers,
            actor,
        })
}
async fn handle(
    State(state): State<TemporaryHttpState>,
    Path(action): Path<String>,
    request: Request,
) -> Response {
    let signed_action = match action.as_str() {
        "install" => "temporary_install",
        "release" => "temporary_release",
        _ => {
            return failure(
                StatusCode::NOT_FOUND,
                "unknown_action",
                ToolEffectState::None,
                true,
            );
        }
    };
    if state.verifiers.is_empty() {
        return failure(
            StatusCode::FORBIDDEN,
            "temporary_disabled",
            ToolEffectState::None,
            true,
        );
    }
    let mut auths = request.headers().get_all(AUTHORIZATION).iter();
    let authorization = match (auths.next(), auths.next()) {
        (Some(header), None) => header.to_str().unwrap_or("").to_owned(),
        _ => {
            return failure(
                StatusCode::UNAUTHORIZED,
                "temporary_unauthorized",
                ToolEffectState::None,
                true,
            );
        }
    };
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let limit = if action == "install" {
        MAX_TEMPORARY_INSTALL_BYTES
    } else {
        4096
    };
    let body =
        match receive_temporary_body(request.into_body(), limit, Duration::from_secs(10)).await {
            Ok(body) => body,
            Err(code) => {
                return failure(
                    if code == "body_timed_out" {
                        StatusCode::REQUEST_TIMEOUT
                    } else {
                        StatusCode::PAYLOAD_TOO_LARGE
                    },
                    code,
                    ToolEffectState::None,
                    true,
                );
            }
        };
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(time) => time.as_secs(),
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "clock_unavailable",
                ToolEffectState::None,
                true,
            );
        }
    };
    let ticket = match verify_maintenance_ticket(
        &authorization,
        &body,
        signed_action,
        &state.status.identity(),
        state.status.execution_id(),
        &state.verifiers,
        now,
    ) {
        Ok(ticket) => ticket,
        Err(_) => {
            return failure(
                StatusCode::UNAUTHORIZED,
                "temporary_unauthorized",
                ToolEffectState::None,
                true,
            );
        }
    };
    let Some(actor) = &state.actor else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporary_unavailable",
            ToolEffectState::None,
            true,
        );
    };
    if action == "install" {
        let prepared = match parse_temporary_install(&content_type, body, &ticket).await {
            Ok(prepared) => prepared,
            Err("request_conflict") => {
                return failure(
                    StatusCode::CONFLICT,
                    "request_conflict",
                    ToolEffectState::None,
                    true,
                );
            }
            Err(_) => {
                return failure(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    ToolEffectState::None,
                    true,
                );
            }
        };
        let input = prepared.into_executor_request(&ticket);
        let span = tracing::info_span!("runtime.skill.temporary.install","run.id"=%ticket.job_id,"skill.content_digest"=%input.content_digest,"skill.artifact_digest"=%input.artifact_digest,"skill.temporary.outcome"=tracing::field::Empty);
        let result = actor
            .install_temporary_skill(input)
            .instrument(span.clone())
            .await;
        span.record(
            "skill.temporary.outcome",
            if result.is_ok() {
                "installed"
            } else {
                "failed"
            },
        );
        match result {
            Ok(installed)=>private_json(Json(json!({"action":signed_action,"request_id":ticket.request_id,"job_id":ticket.job_id,"execution_id":state.status.execution_id(),"outcome":"installed","temporary_path":installed.temporary_path,"content_digest":installed.content_digest,"artifact_digest":installed.artifact_digest,"unpacked_size":installed.unpacked_size,"effect_state":"settled","runtime_call_stopped":true})).into_response()),
            Err(error)=>executor_failure(error),
        }
    } else {
        if content_type.split(';').next().map(str::trim) != Some("application/json") {
            return failure(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                ToolEffectState::None,
                true,
            );
        }
        let metadata = match parse_temporary_release(&body, &ticket) {
            Ok(metadata) => metadata,
            Err(_) => {
                return failure(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    ToolEffectState::None,
                    true,
                );
            }
        };
        let span = tracing::info_span!("runtime.skill.temporary.release","run.id"=%ticket.job_id,"skill.temporary.outcome"=tracing::field::Empty);
        let result = actor
            .release_temporary_skill(metadata.into_executor_request(&ticket))
            .instrument(span.clone())
            .await;
        span.record(
            "skill.temporary.outcome",
            if result.is_ok() { "released" } else { "failed" },
        );
        match result {
            Ok(_)=>private_json(Json(json!({"action":signed_action,"request_id":ticket.request_id,"job_id":ticket.job_id,"execution_id":state.status.execution_id(),"outcome":"released","effect_state":"settled","runtime_call_stopped":true})).into_response()),
            Err(error)=>executor_failure(error),
        }
    }
}
pub(crate) async fn receive_temporary_body(
    body: axum::body::Body,
    limit: usize,
    timeout: Duration,
) -> Result<axum::body::Bytes, &'static str> {
    tokio::time::timeout(timeout, to_bytes(body, limit))
        .await
        .map_err(|_| "body_timed_out")?
        .map_err(|_| "body_too_large")
}
fn executor_failure(error: ToolError) -> Response {
    let (status, code) = match error.code {
        ToolErrorCode::InvalidParams | ToolErrorCode::InvalidPath => {
            (StatusCode::CONFLICT, "request_conflict")
        }
        ToolErrorCode::TemporaryRunClosed => (StatusCode::CONFLICT, "run_closed"),
        ToolErrorCode::TemporaryScopeBusy => (StatusCode::CONFLICT, "temporary_scope_busy"),
        ToolErrorCode::SkillStorageFull => (StatusCode::CONFLICT, "limit_exceeded"),
        ToolErrorCode::RuntimeBusy => (StatusCode::SERVICE_UNAVAILABLE, "runtime_busy"),
        _ if error.effect_state == ToolEffectState::Unknown => {
            (StatusCode::SERVICE_UNAVAILABLE, "outcome_unknown")
        }
        _ => (StatusCode::SERVICE_UNAVAILABLE, "temporary_unavailable"),
    };
    failure(
        status,
        code,
        error.effect_state,
        error.code != ToolErrorCode::ChildProcessContainmentUnproven,
    )
}
fn failure(status: StatusCode, code: &str, effect: ToolEffectState, stopped: bool) -> Response {
    private_json((status,Json(json!({"error":{"code":code,"message":"Temporary Skill request did not complete","retryable":status.is_server_error(),"effect_state":effect,"runtime_call_stopped":stopped}}))).into_response())
}
fn private_json(mut response: Response) -> Response {
    response.headers_mut().insert(
        CACHE_CONTROL,
        "no-store".parse().expect("static cache policy"),
    );
    response
}
