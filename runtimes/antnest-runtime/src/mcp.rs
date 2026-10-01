use std::borrow::Cow;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{
        Method, StatusCode,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use rmcp::{
    RoleServer, ServerHandler,
    handler::server::{tool::ToolCallContext, wrapper::Parameters},
    model::{
        CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, DiscoverResult,
        InitializeRequestParams, InitializeResult, ListResourcesResult, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, ReadResourceResponse,
        ReadResourceResult, Resource, ResourceContents, ResultType,
    },
    service::RequestContext,
    tool, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

use crate::diagnostics;
use crate::execution;
use crate::execution_actor::ExecutionActor;
use crate::executor_protocol::MAX_EXECUTOR_MESSAGE_BYTES;
use crate::information::{INFORMATION_URI, RuntimeContext};
use crate::managed_mcp::catalog::Catalog;
use crate::protocol::types::{
    BashInput, BashResult, EditFileInput, EditFileResult, ReadFileInput, ReadFileResult,
    WriteFileInput, WriteFileResult,
};
#[cfg(test)]
use crate::roots::NamedRoots;
use crate::skill_maintenance_auth::verify_maintenance_ticket;
use crate::skill_maintenance_request::{
    ControlRequest, parse_control_request, parse_prepare_request,
};
use crate::spec::{RuntimeIdentity, SkillMaintenanceVerifier};
use crate::telemetry::RuntimeMetrics;
use crate::tool_error::{ToolEffectState, ToolError, ToolErrorCode};
#[cfg(test)]
use crate::tools::ToolEngine;

pub(crate) const STATUS_PATH: &str = "/status";
pub(crate) const MCP_PATH: &str = "/mcp";
pub(crate) const MAINTENANCE_ROUTE: &str = "/internal/skill-maintenance/{action}";
pub(crate) const EXPECTED_EXECUTION_HEADER: &str = "X-Antnest-Expected-Execution-ID";
#[cfg(test)]
const TOOL_NAMES: [&str; 4] = ["bash", "edit", "read", "write"];

#[derive(JsonSchema, Serialize)]
struct ToolSuccess<T> {
    #[serde(flatten)]
    result: T,
    effect_state: ToolEffectState,
    effect_source: Option<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct RuntimeStatus {
    agent_id: String,
    generation: u64,
    execution_id: String,
    status: &'static str,
}

impl RuntimeStatus {
    pub(crate) fn new(identity: RuntimeIdentity) -> Self {
        Self {
            agent_id: identity.agent_id().to_owned(),
            generation: identity.generation(),
            execution_id: uuid::Uuid::new_v4().to_string(),
            status: "ready",
        }
    }

    #[cfg(test)]
    pub(crate) fn with_execution_id(
        identity: RuntimeIdentity,
        execution_id: impl Into<String>,
    ) -> Self {
        Self {
            agent_id: identity.agent_id().to_owned(),
            generation: identity.generation(),
            execution_id: execution_id.into(),
            status: "ready",
        }
    }

    pub(crate) fn execution_id(&self) -> &str {
        &self.execution_id
    }

    pub(crate) fn identity(&self) -> RuntimeIdentity {
        RuntimeIdentity::new(self.agent_id.clone(), self.generation)
            .expect("RuntimeStatus originates from a valid Runtime identity")
    }
}

pub(crate) struct RuntimeHttp {
    status: RuntimeStatus,
    tools: ToolBackend,
    metrics: RuntimeMetrics,
    managed: Catalog,
    maintenance_verifiers: Vec<SkillMaintenanceVerifier>,
}

impl RuntimeHttp {
    pub(crate) fn new(
        status: RuntimeStatus,
        actor: ExecutionActor,
        metrics: RuntimeMetrics,
        managed: Catalog,
        maintenance_verifiers: Vec<SkillMaintenanceVerifier>,
    ) -> Self {
        Self {
            status,
            tools: ToolBackend::Process(actor),
            metrics,
            managed,
            maintenance_verifiers,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_in_process(status: RuntimeStatus, roots: Arc<NamedRoots>) -> Self {
        Self {
            status,
            tools: ToolBackend::InProcess(ToolEngine::new(roots)),
            metrics: RuntimeMetrics::default(),
            managed: Catalog::default(),
            maintenance_verifiers: Vec::new(),
        }
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn with_managed(mut self, catalog: Catalog) -> Self {
        self.managed = catalog;
        self
    }

    #[cfg(test)]
    pub(crate) fn tool_names() -> Vec<String> {
        TOOL_NAMES.into_iter().map(str::to_owned).collect()
    }

    pub(crate) async fn serve(
        self,
        listener: tokio::net::TcpListener,
        shutdown: CancellationToken,
    ) -> Result<(), std::io::Error> {
        let maintenance_actor = match &self.tools {
            ToolBackend::Process(actor) => Some(actor.clone()),
            #[cfg(test)]
            ToolBackend::InProcess(_) => None,
        };
        let tools = RuntimeToolServer::new(
            self.tools,
            self.status.clone(),
            self.metrics.clone(),
            self.managed.clone(),
        );
        let service: StreamableHttpService<ObservedRuntime, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(ObservedRuntime(tools.clone())),
                Default::default(),
                StreamableHttpServerConfig::default()
                    .disable_allowed_hosts()
                    .with_legacy_session_mode(false)
                    .with_stateless_protocol_metadata_required(true)
                    .with_max_request_body_bytes(MAX_EXECUTOR_MESSAGE_BYTES)
                    .with_cancellation_token(shutdown.child_token()),
            );
        let status = self.status.clone();
        let temporary = crate::skill_temporary_http::temporary_skill_router(
            self.status.clone(),
            self.maintenance_verifiers.clone(),
            maintenance_actor.clone(),
        );
        let maintenance = skill_maintenance_router_with_actor(
            self.status.clone(),
            self.maintenance_verifiers.clone(),
            maintenance_actor,
        );
        let state = HttpState {
            status: self.status,
            metrics: self.metrics,
            managed: self.managed.clone(),
        };
        let health = self.managed;
        let router = Router::new()
            .route(
                STATUS_PATH,
                get(move || status_response(status.clone(), health.clone())),
            )
            .nest_service(MCP_PATH, service)
            .merge(maintenance)
            .merge(temporary)
            .layer(DefaultBodyLimit::max(MAX_EXECUTOR_MESSAGE_BYTES))
            .layer(middleware::from_fn_with_state(state, trace_http_request));
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
    }
}

#[derive(Clone)]
struct MaintenanceState {
    status: RuntimeStatus,
    verifiers: Vec<SkillMaintenanceVerifier>,
    actor: Option<ExecutionActor>,
}

#[cfg(test)]
pub(crate) fn skill_maintenance_router(
    status: RuntimeStatus,
    verifiers: Vec<SkillMaintenanceVerifier>,
) -> Router {
    skill_maintenance_router_with_actor(status, verifiers, None)
}

fn skill_maintenance_router_with_actor(
    status: RuntimeStatus,
    verifiers: Vec<SkillMaintenanceVerifier>,
    actor: Option<ExecutionActor>,
) -> Router {
    Router::new()
        .route(MAINTENANCE_ROUTE, post(maintenance_request))
        .with_state(MaintenanceState {
            status,
            verifiers,
            actor,
        })
}

#[expect(
    clippy::needless_return,
    reason = "each authenticated action exits from its branch"
)]
async fn maintenance_request(
    State(state): State<MaintenanceState>,
    Path(action): Path<String>,
    request: Request,
) -> Response {
    if !matches!(
        action.as_str(),
        "prepare" | "check" | "commit" | "observe" | "cancel" | "release"
    ) {
        return maintenance_error(StatusCode::NOT_FOUND, "unknown_action");
    }
    if state.verifiers.is_empty() {
        return maintenance_error(StatusCode::FORBIDDEN, "maintenance_disabled");
    }
    let mut authorization_headers = request.headers().get_all(AUTHORIZATION).iter();
    let authorization = match (authorization_headers.next(), authorization_headers.next()) {
        (Some(header), None) => header.to_str().unwrap_or("").to_owned(),
        _ => return maintenance_error(StatusCode::UNAUTHORIZED, "maintenance_unauthorized"),
    };
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if authorization.is_empty() {
        return maintenance_error(StatusCode::UNAUTHORIZED, "maintenance_unauthorized");
    }
    if let Some(reason) = execution_fence_error(request.headers(), &state.status) {
        return execution_fence_response(reason);
    }
    let limit = if action == "prepare" {
        8 * 1024 * 1024 + 8 * 1024
    } else {
        16 * 1024
    };
    let body = match to_bytes(request.into_body(), limit).await {
        Ok(bytes) => bytes,
        Err(_) => return maintenance_error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
    };
    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => return maintenance_error(StatusCode::SERVICE_UNAVAILABLE, "clock_unavailable"),
    };
    let ticket = match verify_maintenance_ticket(
        &authorization,
        &body,
        &action,
        &state.status.identity(),
        &state.status.execution_id,
        &state.verifiers,
        now,
    ) {
        Ok(ticket) => ticket,
        Err(_) => return maintenance_error(StatusCode::UNAUTHORIZED, "maintenance_unauthorized"),
    };
    if action == "prepare" {
        match parse_prepare_request(&content_type, body, &ticket).await {
            Ok(candidate) => {
                let Some(actor) = &state.actor else {
                    return maintenance_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "maintenance_unavailable",
                    );
                };
                let result = actor
                    .prepare_skill_candidate(candidate.into_executor_request(&ticket))
                    .await;
                return match result {
                    Ok(prepared) => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "prepare",
                        "execution_id": state.status.execution_id,
                        "outcome": "prepared",
                        "observed_digest": prepared.observed_digest,
                        "storage_key": prepared.candidate_key,
                    }))
                    .into_response(),
                    Err(error) => maintenance_tool_error(error),
                };
            }
            Err("request_conflict") => {
                return maintenance_error(StatusCode::CONFLICT, "request_conflict");
            }
            Err("limit_exceeded") => {
                return maintenance_error(StatusCode::PAYLOAD_TOO_LARGE, "limit_exceeded");
            }
            Err(_) => return maintenance_error(StatusCode::BAD_REQUEST, "invalid_request"),
        }
    } else {
        if content_type != "application/json" {
            return maintenance_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_content_type");
        }
        match parse_control_request(&action, &body, &ticket) {
            Ok(ControlRequest::Check(check)) => {
                let Some(actor) = &state.actor else {
                    return maintenance_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "maintenance_unavailable",
                    );
                };
                let result = actor
                    .check_skill_candidate(check.into_executor_request(&ticket))
                    .await;
                return match result {
                    Ok(checked) => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "check",
                        "execution_id": state.status.execution_id,
                        "outcome": "checked",
                        "observed_digest": checked.observed_digest,
                    }))
                    .into_response(),
                    Err(error) => maintenance_tool_error(error),
                };
            }
            Ok(ControlRequest::Commit(commit)) => {
                let Some(actor) = &state.actor else {
                    return maintenance_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "maintenance_unavailable",
                    );
                };
                let result = actor
                    .commit_skill_candidate(commit.into_executor_request(&ticket))
                    .await;
                return match result {
                    Ok(committed) => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "commit",
                        "execution_id": state.status.execution_id,
                        "outcome": "applied",
                        "observed_digest": committed.observed_digest,
                    }))
                    .into_response(),
                    Err(error) if error.code == ToolErrorCode::SkillWritersUnknown => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "commit",
                        "execution_id": state.status.execution_id,
                        "outcome": "blocked",
                        "observed_digest": null,
                        "blocked_reason": "writers_unknown",
                        "blocked_subject_id": error.blocked_subject_id,
                    }))
                    .into_response(),
                    Err(error) if error.code == ToolErrorCode::SkillBackgroundTaskRunning => {
                        Json(json!({
                            "request_id": ticket.request_id,
                            "action": "commit",
                            "execution_id": state.status.execution_id,
                            "outcome": "blocked",
                            "observed_digest": null,
                            "blocked_reason": "background_task_running",
                            "blocked_subject_id": error.blocked_subject_id,
                        }))
                        .into_response()
                    }
                    Err(error) if error.code == ToolErrorCode::SkillManagedCallInFlight => {
                        Json(json!({
                            "request_id": ticket.request_id,
                            "action": "commit",
                            "execution_id": state.status.execution_id,
                            "outcome": "blocked",
                            "observed_digest": null,
                            "blocked_reason": "managed_call_in_flight",
                            "blocked_subject_id": error.blocked_subject_id,
                        }))
                        .into_response()
                    }
                    Err(error) => maintenance_tool_error(error),
                };
            }
            Ok(ControlRequest::Observe(observe)) => {
                let Some(actor) = &state.actor else {
                    return maintenance_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "maintenance_unavailable",
                    );
                };
                let result = actor
                    .observe_skill_candidate(
                        observe.into_executor_request(&ticket),
                        CancellationToken::new(),
                    )
                    .await;
                return match result {
                    Ok(observed) => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "observe",
                        "execution_id": state.status.execution_id,
                        "outcome": observed.outcome,
                        "observed_digest": observed.observed_digest,
                    }))
                    .into_response(),
                    Err(error) => maintenance_tool_error(error),
                };
            }
            Ok(ControlRequest::Cancel(cancel)) => {
                let Some(actor) = &state.actor else {
                    return maintenance_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "maintenance_unavailable",
                    );
                };
                let result = actor
                    .cancel_skill_generation(cancel.into_executor_request(&ticket))
                    .await;
                return match result {
                    Ok(_) => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "cancel",
                        "execution_id": state.status.execution_id,
                        "outcome": "cancelled",
                        "observed_digest": null,
                    }))
                    .into_response(),
                    Err(error) => maintenance_tool_error(error),
                };
            }
            Ok(ControlRequest::Release(release)) => {
                let Some(actor) = &state.actor else {
                    return maintenance_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "maintenance_unavailable",
                    );
                };
                let result = actor
                    .release_skill_candidate(release.into_executor_request(&ticket))
                    .await;
                return match result {
                    Ok(_) => Json(json!({
                        "request_id": ticket.request_id,
                        "action": "release",
                        "execution_id": state.status.execution_id,
                        "outcome": "released",
                        "observed_digest": null,
                    }))
                    .into_response(),
                    Err(error) => maintenance_tool_error(error),
                };
            }
            Err("request_conflict") => {
                return maintenance_error(StatusCode::CONFLICT, "request_conflict");
            }
            Err(_) => return maintenance_error(StatusCode::BAD_REQUEST, "invalid_request"),
        }
    }
}

fn maintenance_tool_error(error: ToolError) -> Response {
    let (status, code) = match error.code {
        ToolErrorCode::InvalidParams | ToolErrorCode::InvalidPath => {
            (StatusCode::CONFLICT, "request_conflict")
        }
        ToolErrorCode::RuntimeBusy => (StatusCode::SERVICE_UNAVAILABLE, "runtime_busy"),
        ToolErrorCode::OutcomeUnknown => (StatusCode::SERVICE_UNAVAILABLE, "outcome_unknown"),
        ToolErrorCode::AtomicSkillReplaceUnsupported => {
            (StatusCode::CONFLICT, "atomic_skill_replace_unsupported")
        }
        ToolErrorCode::SkillGenerationCancelled => (StatusCode::CONFLICT, "generation_cancelled"),
        ToolErrorCode::SkillStorageFull => (StatusCode::CONFLICT, "skill_storage_full"),
        ToolErrorCode::SkillContentChangedDuringActivation => (
            StatusCode::CONFLICT,
            "skill_content_changed_during_activation",
        ),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "maintenance_unavailable"),
    };
    maintenance_error(status, code)
}

fn maintenance_error(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        Json(json!({"error": {"code": code,
        "message": "Skill maintenance request was not admitted",
        "retryable": status.is_server_error()}})),
    )
        .into_response()
}

#[derive(Clone)]
struct HttpState {
    status: RuntimeStatus,
    metrics: RuntimeMetrics,
    managed: Catalog,
}

async fn status_response(
    mut status: RuntimeStatus,
    managed: Catalog,
) -> (StatusCode, Json<RuntimeStatus>) {
    if managed.healthy() {
        return (StatusCode::OK, Json(status));
    }
    status.status = "unavailable";
    (StatusCode::SERVICE_UNAVAILABLE, Json(status))
}

async fn trace_http_request(
    State(state): State<HttpState>,
    mut request: Request,
    next: Next,
) -> Response {
    let status = &state.status;
    let identity = status.identity();
    let method = request.method().clone();
    let path = route_label(request.uri().path());
    let remote = crate::telemetry::TraceContext::from_headers(request.headers());
    let span = tracing::info_span!(
        parent: None,
        "runtime.http",
        otel.name = %format!("HTTP {} {path}", method_label(&method)),
        "service.name" = crate::telemetry::SERVICE_NAME,
        "antnest.agent.id" = status.agent_id,
        "antnest.runtime.generation" = %status.generation,
        "antnest.runtime.execution.id" = status.execution_id,
        "http.request.method" = method_label(&method),
        "http.route" = tracing::field::Empty,
        "url.path" = path,
        "http.response.status_code" = tracing::field::Empty,
        "http.transport.outcome" = tracing::field::Empty,
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        error.type = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        span_id = tracing::field::Empty,
    );
    crate::telemetry::set_remote_parent(&span, remote.as_ref());
    crate::telemetry::record_span_identity(&span);
    if path != "unmatched" {
        span.record("http.route", path);
    }
    let observation = HttpObservation::new(span.clone());
    request.extensions_mut().insert(observation.clone());
    let body = std::mem::replace(request.body_mut(), Body::empty());
    *request.body_mut() = Body::new(RequestBody {
        inner: Box::pin(body),
        observation: observation.clone(),
    });
    let started = Instant::now();
    let fence_error = if path == MCP_PATH {
        execution_fence_error(request.headers(), status)
    } else {
        None
    };
    let response = match fence_error {
        Some(reason) => execution_fence_response(reason),
        None if path == MCP_PATH && !state.managed.healthy() => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code":"runtime_unavailable", "message":"A required managed MCP service is unavailable"}))).into_response(),
        None => next.run(request).instrument(span.clone()).await,
    };
    if fence_error.is_some() {
        diagnostics::error_summary(
            &span,
            "http.admission",
            "runtime_execution_mismatch",
            "Expected Runtime execution is missing or no longer current",
        );
    }
    let mut completion = HttpCompletion::new(
        span,
        identity,
        method,
        path,
        response.status(),
        state.metrics,
        started,
    );
    completion.observation = Some(observation);
    let (parts, body) = response.into_parts();
    Response::from_parts(parts, Body::new(ObservedBody::new(body, completion)))
}

fn method_label(method: &Method) -> &'static str {
    match *method {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::DELETE => "DELETE",
        Method::PATCH => "PATCH",
        Method::HEAD => "HEAD",
        Method::OPTIONS => "OPTIONS",
        Method::CONNECT => "CONNECT",
        Method::TRACE => "TRACE",
        _ => "_OTHER",
    }
}

#[derive(Clone)]
struct HttpObservation {
    span: tracing::Span,
    request_bytes: Arc<AtomicU64>,
    protocol_failed: Arc<AtomicBool>,
    protocol_succeeded: Arc<AtomicBool>,
}
impl HttpObservation {
    fn new(span: tracing::Span) -> Self {
        Self {
            span,
            request_bytes: Arc::new(AtomicU64::new(0)),
            protocol_failed: Arc::new(AtomicBool::new(false)),
            protocol_succeeded: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct RequestBody {
    inner: Pin<Box<Body>>,
    observation: HttpObservation,
}

impl HttpBody for RequestBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let polled = self.inner.as_mut().poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &polled
            && let Some(data) = frame.data_ref()
        {
            self.observation
                .request_bytes
                .fetch_add(data.len() as u64, Ordering::Relaxed);
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

pub(crate) fn execution_fence_error(
    headers: &axum::http::HeaderMap,
    status: &RuntimeStatus,
) -> Option<&'static str> {
    let Some(expected) = headers
        .get(EXPECTED_EXECUTION_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return Some("missing");
    };
    if expected != status.execution_id {
        return Some("mismatch");
    }
    None
}

fn execution_fence_response(reason: &'static str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "code": "runtime_execution_mismatch",
            "message": "Runtime execution changed; refresh the Runtime inspection before retrying",
            "reason": reason,
        })),
    )
        .into_response()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BodyTermination {
    EndOfStream,
    BodyError,
    ClientDisconnected,
}

struct HttpCompletion {
    span: tracing::Span,
    identity: RuntimeIdentity,
    method: Method,
    path: &'static str,
    status: StatusCode,
    metrics: RuntimeMetrics,
    started: Instant,
    observation: Option<HttpObservation>,
    response_bytes: u64,
}

impl HttpCompletion {
    fn new(
        span: tracing::Span,
        identity: RuntimeIdentity,
        method: Method,
        path: &'static str,
        status: StatusCode,
        metrics: RuntimeMetrics,
        started: Instant,
    ) -> Self {
        Self {
            span,
            identity,
            method,
            path,
            status,
            metrics,
            started,
            observation: None,
            response_bytes: 0,
        }
    }

    fn finish(self, termination: BodyTermination) {
        let code = self.status.as_u16();
        let (outcome, error_type) = match termination {
            BodyTermination::BodyError => ("error", "http_body_error"),
            BodyTermination::ClientDisconnected => ("canceled", "client_disconnected"),
            BodyTermination::EndOfStream => status_outcome(self.status),
        };
        self.metrics.http(
            method_label(&self.method),
            self.path,
            outcome,
            error_type,
            self.started.elapsed(),
        );
        self.span.record("http.response.status_code", code);
        self.span.record("http.transport.outcome", outcome);
        let protocol_failed = self
            .observation
            .as_ref()
            .is_some_and(|observation| observation.protocol_failed.load(Ordering::Relaxed));
        // A completed MCP handler can be followed by an SDK closing its SSE
        // connection before HTTP EOF. This proves handler completion, not client
        // receipt; retain cancellation evidence without inventing an RPC error.
        let completed_mcp_disconnect = termination == BodyTermination::ClientDisconnected
            && self.status.is_success()
            && !protocol_failed
            && self
                .observation
                .as_ref()
                .is_some_and(|observation| observation.protocol_succeeded.load(Ordering::Relaxed));
        self.span.record(
            "otel.status_code",
            if outcome == "error" || protocol_failed || self.status.is_server_error() {
                "ERROR"
            } else {
                "UNSET"
            },
        );
        self.span.set_attribute(
            "http.response.body.size",
            i64::try_from(self.response_bytes).unwrap_or(i64::MAX),
        );
        if let Some(observation) = &self.observation {
            self.span.set_attribute(
                "http.request.body.size",
                i64::try_from(observation.request_bytes.load(Ordering::Relaxed))
                    .unwrap_or(i64::MAX),
            );
        }
        if !error_type.is_empty() {
            self.span
                .set_attribute("http.transport.error.type", error_type);
            if completed_mcp_disconnect {
                self.span.add_event(
                    "antnest.cancelled",
                    vec![
                        opentelemetry::KeyValue::new("antnest.phase", "http"),
                        opentelemetry::KeyValue::new("antnest.cancellation.type", error_type),
                        opentelemetry::KeyValue::new("antnest.protocol.outcome", "success"),
                    ],
                );
            } else if !protocol_failed {
                let diagnostic_type = if termination == BodyTermination::ClientDisconnected
                    && !self.status.is_success()
                {
                    status_outcome(self.status).1
                } else {
                    error_type
                };
                diagnostics::error_summary(
                    &self.span,
                    "http",
                    diagnostic_type,
                    match termination {
                        BodyTermination::BodyError => "HTTP response body failed while streaming",
                        BodyTermination::ClientDisconnected => "HTTP response closed before EOF",
                        BodyTermination::EndOfStream => {
                            "HTTP request returned a non-success status"
                        }
                    },
                );
            }
        }
        let (trace_id, span_id) = crate::telemetry::span_identity(&self.span);
        self.span.in_scope(|| {
            if outcome == "success" {
                tracing::info!(
                    "service.name" = crate::telemetry::SERVICE_NAME,
                    "antnest.agent.id" = self.identity.agent_id(),
                    "antnest.runtime.generation" = %self.identity.generation(),
                    trace_id = %trace_id,
                    span_id = %span_id,
                    "http.request.method" = method_label(&self.method),
                    "url.path" = self.path,
                    "http.response.status_code" = code,
                    "http.transport.outcome" = outcome,
                    error.type = error_type,
                    "Runtime HTTP request completed"
                );
            } else {
                tracing::warn!(
                    "service.name" = crate::telemetry::SERVICE_NAME,
                    "antnest.agent.id" = self.identity.agent_id(),
                    "antnest.runtime.generation" = %self.identity.generation(),
                    trace_id = %trace_id,
                    span_id = %span_id,
                    "http.request.method" = method_label(&self.method),
                    "url.path" = self.path,
                    "http.response.status_code" = code,
                    "http.transport.outcome" = outcome,
                    error.type = error_type,
                    "Runtime HTTP request completed"
                );
            }
        });
    }
}

fn status_outcome(status: StatusCode) -> (&'static str, &'static str) {
    if status.is_success() {
        ("success", "")
    } else if status.is_client_error() {
        ("rejected", "http_client_error")
    } else if status.is_server_error() {
        ("error", "http_server_error")
    } else {
        ("error", "http_non_success")
    }
}

struct ObservedBody {
    inner: Pin<Box<Body>>,
    completion: Option<HttpCompletion>,
    #[cfg(test)]
    probe: Option<tokio::sync::mpsc::UnboundedSender<BodyTermination>>,
}

impl ObservedBody {
    fn new(body: Body, completion: HttpCompletion) -> Self {
        Self {
            inner: Box::pin(body),
            completion: Some(completion),
            #[cfg(test)]
            probe: None,
        }
    }

    #[cfg(test)]
    fn with_probe(
        body: Body,
        span: tracing::Span,
        probe: tokio::sync::mpsc::UnboundedSender<BodyTermination>,
    ) -> Self {
        Self {
            inner: Box::pin(body),
            completion: Some(HttpCompletion::new(
                span,
                RuntimeIdentity::new("agent-http-body-test", 1).unwrap(),
                Method::GET,
                STATUS_PATH,
                StatusCode::OK,
                RuntimeMetrics::default(),
                Instant::now(),
            )),
            probe: Some(probe),
        }
    }

    fn finish(&mut self, termination: BodyTermination) {
        let Some(completion) = self.completion.take() else {
            return;
        };
        completion.finish(termination);
        #[cfg(test)]
        if let Some(probe) = &self.probe {
            let _ = probe.send(termination);
        }
    }
}

impl HttpBody for ObservedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let polled = self.inner.as_mut().poll_frame(context);
        if let (Some(completion), Poll::Ready(Some(Ok(frame)))) = (&mut self.completion, &polled)
            && let Some(data) = frame.data_ref()
        {
            completion.response_bytes = completion.response_bytes.saturating_add(data.len() as u64);
        }
        match &polled {
            Poll::Ready(None) => self.finish(BodyTermination::EndOfStream),
            Poll::Ready(Some(Err(_))) => self.finish(BodyTermination::BodyError),
            Poll::Pending | Poll::Ready(Some(Ok(_))) => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.as_ref().get_ref().is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.as_ref().get_ref().size_hint()
    }
}

impl Drop for ObservedBody {
    fn drop(&mut self) {
        let termination = if self.inner.as_ref().get_ref().is_end_stream() {
            BodyTermination::EndOfStream
        } else {
            BodyTermination::ClientDisconnected
        };
        self.finish(termination);
    }
}

pub(crate) fn route_label(path: &str) -> &'static str {
    if path == STATUS_PATH {
        STATUS_PATH
    } else if path == MCP_PATH || path.starts_with("/mcp/") {
        MCP_PATH
    } else if path.starts_with("/internal/skill-maintenance/") {
        MAINTENANCE_ROUTE
    } else if path.starts_with("/internal/skill-temporary/") {
        crate::skill_temporary_http::TEMPORARY_ROUTE
    } else {
        "unmatched"
    }
}

#[derive(Clone)]
struct RuntimeToolServer {
    tools: ToolBackend,
    identity: RuntimeIdentity,
    execution_id: String,
    metrics: RuntimeMetrics,
    managed: Catalog,
}

impl RuntimeToolServer {
    fn new(
        tools: ToolBackend,
        status: RuntimeStatus,
        metrics: RuntimeMetrics,
        managed: Catalog,
    ) -> Self {
        Self {
            tools,
            identity: status.identity(),
            execution_id: status.execution_id,
            metrics,
            managed,
        }
    }
}

#[derive(Clone)]
enum ToolBackend {
    Process(ExecutionActor),
    #[cfg(test)]
    InProcess(ToolEngine),
}

impl ToolBackend {
    fn admit_managed(&self) -> Result<Option<crate::execution_actor::ExecutionLease>, ToolError> {
        match self {
            Self::Process(actor) => actor.admit().map(Some),
            #[cfg(test)]
            Self::InProcess(_) => Ok(None),
        }
    }
    async fn information(&self, cancel: CancellationToken) -> Result<RuntimeContext, ToolError> {
        match self {
            Self::Process(actor) => actor.info(cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.information(&cancel),
        }
    }

    async fn bash(
        &self,
        input: BashInput,
        cancel: CancellationToken,
        progress: crate::progress::ProgressSink,
    ) -> Result<BashResult, ToolError> {
        let request = execution::BashRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.bash_with_progress(request, cancel, progress).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.bash_with_progress(request, cancel, progress).await,
        };
        result.map(BashResult::from)
    }

    async fn read(
        &self,
        input: ReadFileInput,
        cancel: CancellationToken,
    ) -> Result<
        (
            ReadFileResult,
            Option<crate::file_observation::FileObservation>,
        ),
        ToolError,
    > {
        let request = execution::ReadRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.read(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.read(request, cancel).await,
        };
        result.map(|mut result| {
            let file = result.file.take();
            (ReadFileResult::from(result), file)
        })
    }

    async fn write(
        &self,
        input: WriteFileInput,
        cancel: CancellationToken,
    ) -> Result<
        (
            WriteFileResult,
            Option<crate::file_observation::FileObservation>,
        ),
        ToolError,
    > {
        let request =
            execution::WriteRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.write(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.write(request, cancel).await,
        };
        result.map(|mut result| {
            let file = result.file.take();
            (WriteFileResult::from(result), file)
        })
    }

    async fn edit(
        &self,
        input: EditFileInput,
        cancel: CancellationToken,
    ) -> Result<
        (
            EditFileResult,
            Option<crate::file_observation::FileObservation>,
        ),
        ToolError,
    > {
        let request = execution::EditRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.edit(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.edit(request, cancel).await,
        };
        result.map(|mut result| {
            let file = result.file.take();
            (EditFileResult::from(result), file)
        })
    }
}

#[tool_router]
impl RuntimeToolServer {
    /// Execute a shell command inside the Agent workspace.
    #[tool(
        description = "Execute a bash command in the Agent workspace with a hard timeout",
        output_schema = rmcp::handler::server::tool::schema_for_type::<ToolSuccess<BashResult>>(),
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn bash(
        &self,
        Parameters(input): Parameters<BashInput>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let span = tool_span("bash", &self.identity);
        async {
            let started = Instant::now();
            let result = crate::mcp_progress::with_progress(&context, |progress| {
                self.tools.bash(input, context.ct.clone(), progress)
            })
            .await;
            tool_result("bash", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }

    /// Read UTF-8 text from the workspace or system Skill root.
    #[tool(
        description = "Read a UTF-8 file. Use a string path relative to /workspace or an absolute path under /workspace/ or /skills/. offset is a 1-based line number; limit counts lines, both optional. Follow next_offset when truncated. Prefer read over cat.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<ToolSuccess<ReadFileResult>>(),
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn read(
        &self,
        Parameters(input): Parameters<ReadFileInput>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let span = tool_span("read", &self.identity);
        async {
            let started = Instant::now();
            let result = self.tools.read(input, context.ct).await;
            file_tool_result("read", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }

    /// Replace a workspace file atomically with UTF-8 text.
    #[tool(
        description = "Create or overwrite a workspace file with UTF-8 text; creates parent directories automatically. Use a string path relative to /workspace or under /workspace/. For targeted changes use edit. System Skills under /skills/ are read-only.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<ToolSuccess<WriteFileResult>>(),
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn write(
        &self,
        Parameters(input): Parameters<WriteFileInput>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let span = tool_span("write", &self.identity);
        async {
            let started = Instant::now();
            let result = self.tools.write(input, context.ct).await;
            file_tool_result("write", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }

    /// Replace exactly one matching string in a workspace file.
    #[tool(
        description = "Make a targeted edit in a workspace file using a string path and old_string/new_string. Read the file first. old_string must match exactly once; include enough surrounding text to make it unique. System Skills under /skills/ are read-only.",
        output_schema = rmcp::handler::server::tool::schema_for_type::<ToolSuccess<EditFileResult>>(),
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn edit(
        &self,
        Parameters(input): Parameters<EditFileInput>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let span = tool_span("edit", &self.identity);
        async {
            let started = Instant::now();
            let result = self.tools.edit(input, context.ct).await;
            file_tool_result("edit", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }
}

#[rmcp::tool_handler]
impl ServerHandler for RuntimeToolServer {
    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        Self::tool_router()
            .get(name)
            .cloned()
            .or_else(|| self.managed.get(name))
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, rmcp::ErrorData> {
        context.peer.set_peer_info(request.clone());
        let mut info = self.get_info();
        let supported = self.supported_protocol_versions();
        if supported.contains(&request.protocol_version) {
            info.protocol_version = request.protocol_version;
        }
        Ok(info)
    }

    async fn discover(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, rmcp::ErrorData> {
        Ok(DiscoverResult::from_server_info(
            self.supported_protocol_versions().into_owned(),
            self.get_info(),
        ))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        let supports_cache_hints = context
            .protocol_version()
            .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28);
        Ok(ListToolsResult {
            result_type: Some(ResultType::COMPLETE),
            tools: Self::tool_router()
                .list_all()
                .into_iter()
                .chain(self.managed.tools())
                .collect(),
            meta: None,
            next_cursor: None,
            ttl_ms: supports_cache_hints.then_some(0),
            cache_scope: supports_cache_hints.then_some(CacheScope::Private),
        })
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, rmcp::ErrorData> {
        Ok(ListResourcesResult {
            result_type: Some(ResultType::COMPLETE),
            resources: vec![
                Resource::new(INFORMATION_URI, "runtime-information")
                    .with_description("Current environment, workspace guidance and Skill summaries")
                    .with_mime_type("application/json"),
            ],
            meta: None,
            next_cursor: None,
            ttl_ms: Some(0),
            cache_scope: Some(CacheScope::Private),
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, rmcp::ErrorData> {
        if request.uri != INFORMATION_URI {
            return Err(rmcp::ErrorData::resource_not_found(
                "Unknown Runtime resource",
                None,
            ));
        }
        let information = self.tools.information(context.ct).await.map_err(|error| {
            rmcp::ErrorData::internal_error(
                "Runtime information unavailable",
                Some(json!({
                    "error_code": error.code.as_str()
                })),
            )
        })?;
        #[derive(Serialize)]
        struct Snapshot<'a> {
            execution_id: &'a str,
            #[serde(flatten)]
            context: RuntimeContext,
        }
        let text = serde_json::to_string(&Snapshot {
            execution_id: &self.execution_id,
            context: information,
        })
        .map_err(|_| {
            rmcp::ErrorData::internal_error("Runtime information encoding failed", None)
        })?;
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(text, INFORMATION_URI).with_mime_type("application/json"),
        ])
        .with_ttl_ms(0)
        .with_cache_scope(CacheScope::Private)
        .into())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        reject_reserved_maintenance_tool(&request.name)?;
        reject_tool_continuation(&request)?;
        if self.managed.contains(&request.name) {
            return self.call_managed_tool(request, context).await;
        }
        let call = ToolCallContext::new(self, request, context);
        Self::tool_router().call(call).await
    }

    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::model::ServerConfig::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::from_build_env())
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
}

impl RuntimeToolServer {
    async fn call_managed_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let name = request.name.clone();
        let span = tool_span("managed", &self.identity);
        async {
            let started = Instant::now();
            let result = match self.tools.admit_managed() {
                Ok(_lease) => {
                    crate::mcp_progress::with_progress(&context, |progress| {
                        self.managed.call_with_progress(
                            &name,
                            request.arguments,
                            context.ct.clone(),
                            std::time::Duration::from_secs(120),
                            progress,
                        )
                    })
                    .await
                }
                Err(error) => Err(error),
            };
            Ok(managed_result(
                &name,
                &self.identity,
                &self.metrics,
                started,
                result,
            ))
        }
        .instrument(span)
        .await
    }
}

pub(crate) fn reject_reserved_maintenance_tool(name: &str) -> Result<(), rmcp::ErrorData> {
    if name.starts_with("antnest_skill_maintenance_")
        || name.starts_with("antnest_skill_temporary_")
    {
        return Err(rmcp::ErrorData::invalid_params(
            "Reserved maintenance tool name",
            None,
        ));
    }
    Ok(())
}

fn reject_tool_continuation(request: &CallToolRequestParams) -> Result<(), rmcp::ErrorData> {
    if request.input_responses.is_some() || request.request_state.is_some() {
        return Err(rmcp::ErrorData::invalid_params(
            "Tool continuations are not supported",
            None,
        ));
    }
    Ok(())
}

fn managed_result(
    name: &str,
    identity: &RuntimeIdentity,
    metrics: &RuntimeMetrics,
    started: Instant,
    result: Result<CallToolResult, ToolError>,
) -> CallToolResponse {
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            return tool_result::<serde_json::Value>(
                "managed",
                identity,
                metrics,
                started,
                Err(error),
            )
            .into();
        }
    };
    let (outcome, error) = if value.is_error == Some(true) {
        ("error", "managed_tool_error")
    } else {
        ("success", "")
    };
    metrics.tool("managed", outcome, error, started.elapsed());
    tracing::Span::current().record("mcp.tool.outcome", outcome);
    tracing::Span::current().record(
        "otel.status_code",
        if error.is_empty() { "OK" } else { "ERROR" },
    );
    tracing::Span::current().record("error.type", error);
    tracing::info!(mcp.server.tool = name, outcome, error.type = error, "Managed MCP tool finished");
    value.into()
}

#[derive(Clone)]
struct ObservedRuntime(RuntimeToolServer);

impl ServerHandler for ObservedRuntime {
    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        self.0.get_tool(name)
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, rmcp::ErrorData> {
        let input = rmcp::model::ClientRequest::InitializeRequest(
            rmcp::model::InitializeRequest::new(request.clone()),
        );
        observe_mcp_operation(&self.0, input, context, |context| {
            self.0.initialize(request, context)
        })
        .await
    }

    async fn discover(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, rmcp::ErrorData> {
        let input = rmcp::model::ClientRequest::DiscoverRequest(Default::default());
        observe_mcp_operation(&self.0, input, context, |context| self.0.discover(context)).await
    }

    async fn ping(&self, context: RequestContext<RoleServer>) -> Result<(), rmcp::ErrorData> {
        let input = rmcp::model::ClientRequest::PingRequest(Default::default());
        observe_mcp_operation(&self.0, input, context, |context| self.0.ping(context)).await
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        let input = rmcp::model::ClientRequest::ListToolsRequest(rmcp::model::ListToolsRequest {
            params: request.clone(),
            ..Default::default()
        });
        observe_mcp_operation(&self.0, input, context, |context| {
            self.0.list_tools(request, context)
        })
        .await
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, rmcp::ErrorData> {
        let input =
            rmcp::model::ClientRequest::ListResourcesRequest(rmcp::model::ListResourcesRequest {
                params: request.clone(),
                ..Default::default()
            });
        observe_mcp_operation(&self.0, input, context, |context| {
            self.0.list_resources(request, context)
        })
        .await
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, rmcp::ErrorData> {
        let input = rmcp::model::ClientRequest::ReadResourceRequest(
            rmcp::model::ReadResourceRequest::new(request.clone()),
        );
        observe_mcp_operation(&self.0, input, context, |context| {
            self.0.read_resource(request, context)
        })
        .await
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let input = rmcp::model::ClientRequest::CallToolRequest(rmcp::model::CallToolRequest::new(
            request.clone(),
        ));
        observe_mcp_operation(&self.0, input, context, |context| {
            self.0.call_tool(request, context)
        })
        .await
    }

    fn get_info(&self) -> rmcp::model::ServerConfig {
        ServerHandler::get_info(&self.0)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        ServerHandler::supported_protocol_versions(&self.0)
    }
}

async fn observe_mcp_operation<R, F>(
    server: &RuntimeToolServer,
    request: rmcp::model::ClientRequest,
    context: RequestContext<RoleServer>,
    execute: impl FnOnce(RequestContext<RoleServer>) -> F,
) -> Result<R, rmcp::ErrorData>
where
    R: diagnostics::ProtocolResult,
    F: std::future::Future<Output = Result<R, rmcp::ErrorData>>,
{
    let operation = diagnostics::operation(&request);
    let tool = diagnostics::primitive_tool(&request);
    let identity = &server.identity;
    let metrics = &server.metrics;
    let http = context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<HttpObservation>())
        .cloned();
    let parent = http.as_ref().map_or_else(
        || tracing::Span::current().context(),
        |http| http.span.context(),
    );
    let span = tracing::info_span!(
        parent: None,
        "runtime.mcp.operation",
        "service.name" = crate::telemetry::SERVICE_NAME,
        "antnest.agent.id" = identity.agent_id(),
        "antnest.runtime.generation" = %identity.generation(),
        "mcp.operation.name" = operation,
        "rpc.system" = "jsonrpc",
        "rpc.service" = "antnest-runtime",
        "rpc.method" = operation,
        "antnest.runtime.execution.id" = server.execution_id,
        "mcp.operation.outcome" = tracing::field::Empty,
        "jsonrpc.error_code" = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        span_id = tracing::field::Empty,
    );
    let _ = span.set_parent(parent);
    crate::telemetry::record_span_identity(&span);
    if let rmcp::model::ClientRequest::CallToolRequest(request) = &request
        && (tool.is_some() || server.managed.contains(&request.params.name))
    {
        span.set_attribute("mcp.tool.name", request.params.name.to_string());
    }
    let request_id = context.id.to_string();
    if request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        span.set_attribute("antnest.request.id", request_id);
    }
    diagnostics::rpc_content(
        &span,
        "antnest.request",
        metrics.capture_rpc_content,
        &request,
    );
    let started = Instant::now();
    let result = execute(context).instrument(span.clone()).await;
    let (outcome, error_type, error_code) = match &result {
        Ok(value) => match diagnostics::protocol_error(tool, value) {
            Some(code) => ("error", code, None),
            None => ("success", "", None),
        },
        Err(error) => (
            "error",
            jsonrpc_error_type(error.code.0),
            Some(error.code.0),
        ),
    };
    span.record("mcp.operation.outcome", outcome);
    span.set_attribute(
        "antnest.operation.outcome",
        match error_type {
            "canceled" => "canceled",
            "runtime_busy" | "runtime_unavailable" | "invalid_params" | "invalid_path" => {
                "rejected"
            }
            _ => outcome,
        },
    );
    span.record(
        "otel.status_code",
        if outcome == "success" { "OK" } else { "ERROR" },
    );
    span.record("error.type", error_type);
    if let Some(code) = error_code {
        span.record("jsonrpc.error_code", i64::from(code));
        span.add_event(
            "antnest.error",
            vec![
                opentelemetry::KeyValue::new("antnest.error.stage", "mcp.dispatch"),
                opentelemetry::KeyValue::new("antnest.error.type", error_type),
                opentelemetry::KeyValue::new("antnest.error.code", code.to_string()),
                opentelemetry::KeyValue::new("antnest.error.message", jsonrpc_safe_message(code)),
            ],
        );
    } else if outcome == "error" {
        diagnostics::error_summary(
            &span,
            "mcp.dispatch",
            error_type,
            "Tool returned an unsuccessful protocol result",
        );
    }
    if let Some(http) = &http {
        http.span.set_attribute("rpc.system", "jsonrpc");
        http.span.set_attribute("rpc.method", operation);
        http.span.set_attribute("antnest.protocol.outcome", outcome);
        if outcome == "error" {
            http.protocol_failed.store(true, Ordering::Relaxed);
            http.span.set_attribute("error.type", error_type);
        } else {
            http.protocol_succeeded.store(true, Ordering::Relaxed);
        }
    }
    match &result {
        Ok(value) => value.capture(&span, metrics.capture_rpc_content),
        Err(error) => diagnostics::rpc_content(
            &span,
            "antnest.response",
            metrics.capture_rpc_content,
            error,
        ),
    }
    metrics.mcp(operation, outcome, error_type, started.elapsed());
    let (trace_id, span_id) = crate::telemetry::span_identity(&span);
    span.in_scope(|| {
        tracing::info!(
            "service.name" = crate::telemetry::SERVICE_NAME,
            "antnest.agent.id" = identity.agent_id(),
            "antnest.runtime.generation" = %identity.generation(),
            trace_id = %trace_id,
            span_id = %span_id,
            "mcp.operation.name" = operation,
            "mcp.operation.outcome" = outcome,
            "jsonrpc.error_code" = error_code,
            error.type = error_type,
            "Runtime MCP operation completed"
        );
    });
    result
}

fn jsonrpc_safe_message(code: i32) -> &'static str {
    match code {
        -32_022 => "MCP protocol version is unsupported",
        -32_021 => "Required client capability is missing",
        -32_020 => "MCP header and request metadata disagree",
        -32_002 => "Runtime resource was not found",
        -32_600 => "MCP request is invalid",
        -32_601 => "MCP method is not supported",
        -32_602 => "MCP parameters failed validation",
        -32_603 => "MCP operation failed internally",
        -32_700 => "MCP request could not be parsed",
        _ => "MCP operation returned a protocol error",
    }
}

fn jsonrpc_error_type(code: i32) -> &'static str {
    match code {
        -32_022 => "unsupported_protocol_version",
        -32_021 => "missing_required_client_capability",
        -32_020 => "header_mismatch",
        -32_002 => "resource_not_found",
        -32_600 => "invalid_request",
        -32_601 => "method_not_found",
        -32_602 => "invalid_params",
        -32_603 => "internal_error",
        -32_700 => "parse_error",
        _ => "jsonrpc_error",
    }
}

fn tool_span(name: &'static str, identity: &RuntimeIdentity) -> tracing::Span {
    let span = tracing::info_span!(
        "runtime.mcp.tool",
        "service.name" = crate::telemetry::SERVICE_NAME,
        "antnest.agent.id" = identity.agent_id(),
        "antnest.runtime.generation" = %identity.generation(),
        "mcp.tool.name" = name,
        "mcp.tool.outcome" = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        span_id = tracing::field::Empty,
    );
    crate::telemetry::record_span_identity(&span);
    span
}

fn file_tool_result<T: Serialize>(
    name: &'static str,
    identity: &RuntimeIdentity,
    metrics: &RuntimeMetrics,
    started: Instant,
    result: Result<(T, Option<crate::file_observation::FileObservation>), ToolError>,
) -> CallToolResult {
    let (result, file) = match result {
        Ok((value, file)) => (Ok(value), file),
        Err(error) => (Err(error), None),
    };
    let mut reply = tool_result(name, identity, metrics, started, result);
    if reply.is_error != Some(true) {
        reply.meta = file
            .and_then(crate::file_observation_wire::WireFileObservation::bounded)
            .and_then(|wire| serde_json::from_value(wire.metadata()).ok());
    }
    reply
}

fn tool_result<T: Serialize>(
    name: &'static str,
    identity: &RuntimeIdentity,
    metrics: &RuntimeMetrics,
    started: Instant,
    result: Result<T, ToolError>,
) -> CallToolResult {
    let (trace_id, span_id) = crate::telemetry::span_identity(&tracing::Span::current());
    match result {
        Ok(value) => match serde_json::to_value(ToolSuccess {
            result: value,
            effect_state: ToolEffectState::Settled,
            effect_source: None,
        }) {
            Ok(value) => {
                metrics.tool(name, "success", "", started.elapsed());
                tracing::Span::current().record("mcp.tool.outcome", "success");
                tracing::Span::current().record("otel.status_code", "OK");
                tracing::info!(
                    "service.name" = crate::telemetry::SERVICE_NAME,
                    "antnest.agent.id" = identity.agent_id(),
                    "antnest.runtime.generation" = %identity.generation(),
                    trace_id = %trace_id,
                    span_id = %span_id,
                    tool = name,
                    outcome = "success",
                    "Runtime MCP tool completed"
                );
                CallToolResult::structured(value)
            }
            Err(error) => {
                metrics.tool(
                    name,
                    "error",
                    ToolErrorCode::EncodeResultFailed.as_str(),
                    started.elapsed(),
                );
                tracing::Span::current().record("mcp.tool.outcome", "error");
                tracing::Span::current().record("otel.status_code", "ERROR");
                tracing::Span::current()
                    .record("error.type", ToolErrorCode::EncodeResultFailed.as_str());
                tracing::warn!(
                    "service.name" = crate::telemetry::SERVICE_NAME,
                    "antnest.agent.id" = identity.agent_id(),
                    "antnest.runtime.generation" = %identity.generation(),
                    trace_id = %trace_id,
                    span_id = %span_id,
                    tool = name,
                    outcome = "error",
                    error.type = %ToolErrorCode::EncodeResultFailed,
                    reason = diagnostics::safe_tool_message(ToolErrorCode::EncodeResultFailed),
                    "Runtime MCP tool failed"
                );
                CallToolResult::structured_error(json!({
                    "error_code": ToolErrorCode::EncodeResultFailed,
                    "message": error.to_string(),
                    "effect_state": ToolEffectState::Settled,
                    "effect_source": null
                }))
            }
        },
        Err(error) => {
            diagnostics::error_summary(
                &tracing::Span::current(),
                "mcp.tool",
                error.code.as_str(),
                diagnostics::safe_tool_message(error.code),
            );
            let code = error.code;
            let message = error.message;
            let effect_state = error.effect_state;
            metrics.tool(name, "error", code.as_str(), started.elapsed());
            tracing::Span::current().record("mcp.tool.outcome", "error");
            tracing::Span::current().record("otel.status_code", "ERROR");
            tracing::Span::current().record("error.type", code.as_str());
            tracing::warn!(
                "service.name" = crate::telemetry::SERVICE_NAME,
                "antnest.agent.id" = identity.agent_id(),
                "antnest.runtime.generation" = %identity.generation(),
                trace_id = %trace_id,
                span_id = %span_id,
                tool = name,
                error.type = %code,
                reason = diagnostics::safe_tool_message(code),
                "Runtime MCP tool failed"
            );
            CallToolResult::structured_error(json!({
                "error_code": code,
                "message": message,
                "effect_state": effect_state,
                "effect_source": (effect_state == ToolEffectState::Unknown).then_some("runtime_mcp")
            }))
        }
    }
}

#[cfg(test)]
#[path = "mcp_observability_tests.rs"]
mod observability_tests;

#[cfg(test)]
mod response_body_tests {
    use axum::body::{Body, to_bytes};
    use tokio::sync::mpsc;

    use super::{BodyTermination, ObservedBody};

    #[tokio::test]
    async fn http_observation_finishes_at_response_body_end() {
        let (events, mut observed) = mpsc::unbounded_channel();
        let body = ObservedBody::with_probe(
            Body::from("response"),
            tracing::info_span!("http-body-test"),
            events,
        );

        let bytes = to_bytes(Body::new(body), 32).await.unwrap();

        assert_eq!(&bytes[..], b"response");
        assert_eq!(observed.recv().await, Some(BodyTermination::EndOfStream));
    }

    #[test]
    fn dropped_response_body_is_observed_as_a_disconnect() {
        let (events, mut observed) = mpsc::unbounded_channel();
        let body = ObservedBody::with_probe(
            Body::from("response"),
            tracing::info_span!("http-body-drop-test"),
            events,
        );

        drop(body);

        assert_eq!(
            observed.try_recv().unwrap(),
            BodyTermination::ClientDisconnected
        );
    }
}

#[cfg(test)]
mod tool_result_tests {
    use std::time::Instant;

    use serde_json::json;

    use super::tool_result;
    use crate::spec::RuntimeIdentity;
    use crate::telemetry::RuntimeMetrics;
    use crate::tool_error::{ToolError, ToolErrorCode};

    #[test]
    fn tool_continuations_are_rejected_before_dispatch() {
        for name in ["bash", "mcp__fixture__check"] {
            for continuation in [
                json!({"requestState": "state"}),
                json!({"inputResponses": {"answer": {"action": "accept"}}}),
                json!({"inputResponses": {}}),
            ] {
                let mut request = continuation;
                request["name"] = json!(name);
                let request = serde_json::from_value(request).unwrap();
                let error = super::reject_tool_continuation(&request).unwrap_err();
                assert_eq!(error.code, rmcp::model::ErrorCode::INVALID_PARAMS);
            }
            assert!(
                super::reject_tool_continuation(&rmcp::model::CallToolRequestParams::new(name))
                    .is_ok()
            );
        }
    }

    #[test]
    fn managed_input_failure_retains_unknown_effects() {
        let response = super::managed_result(
            "mcp__test__ask",
            &identity(),
            &RuntimeMetrics::default(),
            Instant::now(),
            Err(ToolError::outcome_unknown(
                "managed tool input is not supported; effects unobserved",
            )),
        );
        let rmcp::model::CallToolResponse::Complete(result) = response else {
            panic!("expected explicit tool failure")
        };
        assert_eq!(result.is_error, Some(true));
        let value = result.structured_content.unwrap();
        assert_eq!(value["error_code"], "outcome_unknown");
        assert_eq!(value["effect_state"], "unknown");
        assert_eq!(value["effect_source"], "runtime_mcp");
    }

    #[test]
    fn managed_input_failure_is_traced_as_error_not_waiting_input() {
        use opentelemetry::trace::TracerProvider as _;
        use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
        use tracing_subscriber::prelude::*;

        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry().with(
            tracing_opentelemetry::layer().with_tracer(provider.tracer("managed-input-test")),
        );
        tracing::subscriber::with_default(subscriber, || {
            let span = super::tool_span("managed", &identity());
            span.in_scope(|| {
                super::managed_result(
                    "mcp__test__ask",
                    &identity(),
                    &RuntimeMetrics::default(),
                    Instant::now(),
                    Err(ToolError::outcome_unknown(
                        "managed tool input is not supported; effects unobserved",
                    )),
                );
            });
        });
        provider.force_flush().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        let span = spans
            .iter()
            .find(|span| span.name == "runtime.mcp.tool")
            .unwrap();
        assert!(matches!(
            span.status,
            opentelemetry::trace::Status::Error { .. }
        ));
        assert!(
            span.attributes
                .iter()
                .any(|attr| attr.key.as_str() == "mcp.tool.outcome"
                    && attr.value.as_str() == "error")
        );
        assert!(
            span.attributes
                .iter()
                .any(|attr| attr.key.as_str() == "error.type"
                    && attr.value.as_str() == "outcome_unknown")
        );
        assert!(!format!("{span:?}").contains("canary"));
        provider.shutdown().unwrap();
    }

    #[test]
    fn successful_result_declares_settled_effect() {
        let result = tool_result(
            "write",
            &identity(),
            &RuntimeMetrics::default(),
            Instant::now(),
            Ok(json!({"bytes_written": 5})),
        );

        assert_eq!(result.is_error, Some(false));
        let structured = result.structured_content.expect("structured result");
        assert_eq!(structured["bytes_written"], 5);
        assert_eq!(structured["effect_state"], "settled");
        assert!(structured["effect_source"].is_null());
    }

    #[test]
    fn error_result_preserves_none_and_unknown_effects() {
        let known = super::file_tool_result::<serde_json::Value>(
            "write",
            &identity(),
            &RuntimeMetrics::default(),
            Instant::now(),
            Err(ToolError::new(ToolErrorCode::InvalidPath, "invalid path")),
        );
        assert!(known.meta.is_none());
        let structured = known.structured_content.expect("known error");
        assert_eq!(structured["error_code"], "invalid_path");
        assert_eq!(structured["effect_state"], "none");
        assert!(structured["effect_source"].is_null());

        let unknown = super::file_tool_result::<serde_json::Value>(
            "write",
            &identity(),
            &RuntimeMetrics::default(),
            Instant::now(),
            Err(ToolError::outcome_unknown("write outcome is unknown")),
        );
        assert!(unknown.meta.is_none());
        let structured = unknown.structured_content.expect("unknown error");
        assert_eq!(structured["error_code"], "outcome_unknown");
        assert_eq!(structured["effect_state"], "unknown");
        assert_eq!(structured["effect_source"], "runtime_mcp");
    }

    #[test]
    fn file_observation_is_metadata_only_and_never_changes_model_output() {
        use crate::file_observation::{FileChange, FileObservation};
        let result = super::file_tool_result(
            "write",
            &identity(),
            &RuntimeMetrics::default(),
            Instant::now(),
            Ok((
                json!({"bytes_written": 3}),
                Some(FileObservation {
                    path: "/workspace/actual.txt".into(),
                    change: Some(FileChange::text(Some(b"BEFORE-MARKER"), b"new")),
                }),
            )),
        );
        assert_eq!(result.is_error, Some(false));
        assert!(
            serde_json::to_string(&result.meta)
                .unwrap()
                .contains("BEFORE-MARKER")
        );
        assert!(
            !serde_json::to_string(&result.content)
                .unwrap()
                .contains("BEFORE-MARKER")
        );
        assert_eq!(
            result.structured_content.unwrap(),
            json!({"bytes_written": 3, "effect_state": "settled", "effect_source": null})
        );
    }

    fn identity() -> RuntimeIdentity {
        RuntimeIdentity::new("agent-1", 1).expect("identity")
    }
}
