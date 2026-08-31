use std::borrow::Cow;
use std::pin::Pin;
#[cfg(test)]
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use rmcp::{
    RoleServer, ServerHandler,
    handler::server::{tool::ToolCallContext, wrapper::Parameters},
    model::{
        CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, DiscoverResult,
        InitializeRequestParams, InitializeResult, ListToolsResult, PaginatedRequestParams,
        ProtocolVersion, ResultType,
    },
    service::RequestContext,
    tool, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::execution;
use crate::execution_actor::ExecutionActor;
use crate::executor_protocol::MAX_EXECUTOR_MESSAGE_BYTES;
use crate::protocol::types::{
    BashInput, BashResult, EditFileInput, EditFileResult, ReadFileInput, ReadFileResult,
    WriteFileInput, WriteFileResult,
};
#[cfg(test)]
use crate::roots::NamedRoots;
use crate::spec::RuntimeIdentity;
use crate::telemetry::RuntimeMetrics;
use crate::tool_error::{ToolError, ToolErrorCode};
#[cfg(test)]
use crate::tools::ToolEngine;

pub(crate) const STATUS_PATH: &str = "/status";
pub(crate) const MCP_PATH: &str = "/mcp";
pub(crate) const EXPECTED_EXECUTION_HEADER: &str = "X-Antnest-Expected-Execution-ID";
#[cfg(test)]
const TOOL_NAMES: [&str; 4] = ["bash", "edit", "read", "write"];

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

    fn identity(&self) -> RuntimeIdentity {
        RuntimeIdentity::new(self.agent_id.clone(), self.generation)
            .expect("RuntimeStatus originates from a valid Runtime identity")
    }
}

pub(crate) struct RuntimeHttp {
    status: RuntimeStatus,
    tools: ToolBackend,
    metrics: RuntimeMetrics,
}

impl RuntimeHttp {
    pub(crate) fn new(
        status: RuntimeStatus,
        actor: ExecutionActor,
        metrics: RuntimeMetrics,
    ) -> Self {
        Self {
            status,
            tools: ToolBackend::Process(actor),
            metrics,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_in_process(status: RuntimeStatus, roots: Arc<NamedRoots>) -> Self {
        Self {
            status,
            tools: ToolBackend::InProcess(ToolEngine::new(roots)),
            metrics: RuntimeMetrics::default(),
        }
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
        let tools =
            RuntimeToolServer::new(self.tools, self.status.identity(), self.metrics.clone());
        let service: StreamableHttpService<RuntimeToolServer, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(tools.clone()),
                Default::default(),
                StreamableHttpServerConfig::default()
                    .disable_allowed_hosts()
                    .with_legacy_session_mode(false)
                    .with_stateless_protocol_metadata_required(true)
                    .with_max_request_body_bytes(MAX_EXECUTOR_MESSAGE_BYTES)
                    .with_cancellation_token(shutdown.child_token()),
            );
        let status = self.status.clone();
        let state = HttpState {
            status: self.status,
            metrics: self.metrics,
        };
        let router = Router::new()
            .route(STATUS_PATH, get(move || status_response(status.clone())))
            .nest_service(MCP_PATH, service)
            .layer(DefaultBodyLimit::max(MAX_EXECUTOR_MESSAGE_BYTES))
            .layer(middleware::from_fn_with_state(state, trace_http_request));
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
    }
}

#[derive(Clone)]
struct HttpState {
    status: RuntimeStatus,
    metrics: RuntimeMetrics,
}

async fn status_response(status: RuntimeStatus) -> Json<RuntimeStatus> {
    Json(status)
}

async fn trace_http_request(
    State(state): State<HttpState>,
    request: Request,
    next: Next,
) -> Response {
    let status = &state.status;
    let identity = status.identity();
    let method = request.method().clone();
    let path = route_label(request.uri().path());
    let remote = crate::telemetry::TraceContext::from_headers(request.headers());
    let span = tracing::info_span!(
        "runtime.http",
        "service.name" = crate::telemetry::SERVICE_NAME,
        "antnest.agent.id" = status.agent_id,
        "antnest.runtime.generation" = %status.generation,
        "http.request.method" = %method,
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
    let started = Instant::now();
    let fence_error = if path == MCP_PATH {
        execution_fence_error(request.headers(), status)
    } else {
        None
    };
    let response = match fence_error {
        Some(reason) => execution_fence_response(reason),
        None => next.run(request).instrument(span.clone()).await,
    };
    let completion = HttpCompletion::new(
        span,
        identity,
        method,
        path,
        response.status(),
        state.metrics,
        started,
    );
    let (parts, body) = response.into_parts();
    Response::from_parts(parts, Body::new(ObservedBody::new(body, completion)))
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
        }
    }

    fn finish(self, termination: BodyTermination) {
        let code = self.status.as_u16();
        let (outcome, error_type) = match termination {
            BodyTermination::BodyError => ("error", "http_body_error"),
            BodyTermination::ClientDisconnected => ("error", "client_disconnected"),
            BodyTermination::EndOfStream => status_outcome(self.status),
        };
        self.metrics.http(
            self.method.as_str(),
            self.path,
            outcome,
            error_type,
            self.started.elapsed(),
        );
        self.span.record("http.response.status_code", code);
        self.span.record("http.transport.outcome", outcome);
        self.span.record(
            "otel.status_code",
            if outcome == "success" { "OK" } else { "ERROR" },
        );
        if !error_type.is_empty() {
            self.span.record("error.type", error_type);
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
                    "http.request.method" = %self.method,
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
                    "http.request.method" = %self.method,
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
        ("error", "http_client_error")
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
    } else {
        "unmatched"
    }
}

#[derive(Clone)]
struct RuntimeToolServer {
    tools: ToolBackend,
    identity: RuntimeIdentity,
    metrics: RuntimeMetrics,
}

impl RuntimeToolServer {
    fn new(tools: ToolBackend, identity: RuntimeIdentity, metrics: RuntimeMetrics) -> Self {
        Self {
            tools,
            identity,
            metrics,
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
    async fn bash(
        &self,
        input: BashInput,
        cancel: CancellationToken,
    ) -> Result<BashResult, ToolError> {
        let request = execution::BashRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.bash(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.bash(request, cancel).await,
        };
        result.map(BashResult::from)
    }

    async fn read(
        &self,
        input: ReadFileInput,
        cancel: CancellationToken,
    ) -> Result<ReadFileResult, ToolError> {
        let request = execution::ReadRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.read(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.read(request, cancel).await,
        };
        result.map(ReadFileResult::from)
    }

    async fn write(
        &self,
        input: WriteFileInput,
        cancel: CancellationToken,
    ) -> Result<WriteFileResult, ToolError> {
        let request =
            execution::WriteRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.write(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.write(request, cancel).await,
        };
        result.map(WriteFileResult::from)
    }

    async fn edit(
        &self,
        input: EditFileInput,
        cancel: CancellationToken,
    ) -> Result<EditFileResult, ToolError> {
        let request = execution::EditRequest::try_from(input).map_err(ToolError::invalid_params)?;
        let result = match self {
            Self::Process(actor) => actor.edit(request, cancel).await,
            #[cfg(test)]
            Self::InProcess(engine) => engine.edit(request, cancel).await,
        };
        result.map(EditFileResult::from)
    }
}

#[tool_router]
impl RuntimeToolServer {
    /// Execute a shell command inside the Agent workspace.
    #[tool(
        description = "Execute a bash command in the Agent workspace with a hard timeout",
        output_schema = rmcp::handler::server::tool::schema_for_type::<BashResult>(),
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
            let result = self.tools.bash(input, context.ct).await;
            tool_result("bash", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }

    /// Read UTF-8 text from the workspace or system Skill root.
    #[tool(
        description = "Read UTF-8 text from a file beneath a named Runtime root",
        output_schema = rmcp::handler::server::tool::schema_for_type::<ReadFileResult>(),
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
            tool_result("read", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }

    /// Replace a workspace file atomically with UTF-8 text.
    #[tool(
        description = "Atomically replace a workspace file with UTF-8 text",
        output_schema = rmcp::handler::server::tool::schema_for_type::<WriteFileResult>(),
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
            tool_result("write", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }

    /// Replace exactly one matching string in a workspace file.
    #[tool(
        description = "Replace exactly one matching string in a workspace file",
        output_schema = rmcp::handler::server::tool::schema_for_type::<EditFileResult>(),
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
            tool_result("edit", &self.identity, &self.metrics, started, result)
        }
        .instrument(span)
        .await
    }
}

#[rmcp::tool_handler]
impl ServerHandler for RuntimeToolServer {
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, rmcp::ErrorData> {
        observe_mcp_operation("initialize", &self.identity, &self.metrics, async {
            context.peer.set_peer_info(request.clone());
            let mut info = self.get_info();
            let supported = self.supported_protocol_versions();
            if supported.contains(&request.protocol_version) {
                info.protocol_version = request.protocol_version;
            }
            Ok(info)
        })
        .await
    }

    async fn discover(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, rmcp::ErrorData> {
        observe_mcp_operation("discover", &self.identity, &self.metrics, async {
            Ok(DiscoverResult::from_server_info(
                self.supported_protocol_versions().into_owned(),
                self.get_info(),
            ))
        })
        .await
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        observe_mcp_operation("tools/list", &self.identity, &self.metrics, async {
            let supports_cache_hints = context
                .protocol_version()
                .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28);
            Ok(ListToolsResult {
                result_type: Some(ResultType::COMPLETE),
                tools: Self::tool_router().list_all(),
                meta: None,
                next_cursor: None,
                ttl_ms: supports_cache_hints.then_some(0),
                cache_scope: supports_cache_hints.then_some(CacheScope::Public),
            })
        })
        .await
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        observe_mcp_operation("tools/call", &self.identity, &self.metrics, async {
            let call = ToolCallContext::new(self, request, context);
            Self::tool_router().call(call).await
        })
        .await
    }

    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::from_build_env())
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
}

async fn observe_mcp_operation<T>(
    operation: &'static str,
    identity: &RuntimeIdentity,
    metrics: &RuntimeMetrics,
    future: impl std::future::Future<Output = Result<T, rmcp::ErrorData>>,
) -> Result<T, rmcp::ErrorData> {
    let span = tracing::info_span!(
        "runtime.mcp.operation",
        "service.name" = crate::telemetry::SERVICE_NAME,
        "antnest.agent.id" = identity.agent_id(),
        "antnest.runtime.generation" = %identity.generation(),
        "mcp.operation.name" = operation,
        "mcp.operation.outcome" = tracing::field::Empty,
        "jsonrpc.error_code" = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        span_id = tracing::field::Empty,
    );
    crate::telemetry::record_span_identity(&span);
    let started = Instant::now();
    let result = future.instrument(span.clone()).await;
    let (outcome, error_type, error_code) = match &result {
        Ok(_) => ("success", "", None),
        Err(error) => (
            "error",
            jsonrpc_error_type(error.code.0),
            Some(error.code.0),
        ),
    };
    span.record("mcp.operation.outcome", outcome);
    span.record(
        "otel.status_code",
        if result.is_ok() { "OK" } else { "ERROR" },
    );
    span.record("error.type", error_type);
    if let Some(code) = error_code {
        span.record("jsonrpc.error_code", i64::from(code));
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

fn tool_result<T: Serialize>(
    name: &'static str,
    identity: &RuntimeIdentity,
    metrics: &RuntimeMetrics,
    started: Instant,
    result: Result<T, ToolError>,
) -> CallToolResult {
    let (trace_id, span_id) = crate::telemetry::span_identity(&tracing::Span::current());
    match result {
        Ok(value) => match serde_json::to_value(value) {
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
                    reason = %error,
                    "Runtime MCP tool failed"
                );
                CallToolResult::structured_error(json!({
                    "code": ToolErrorCode::EncodeResultFailed,
                    "message": error.to_string()
                }))
            }
        },
        Err(error) => {
            let code = error.code;
            let message = error.message;
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
                reason = %message,
                "Runtime MCP tool failed"
            );
            CallToolResult::structured_error(json!({
                "code": code,
                "message": message
            }))
        }
    }
}

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
