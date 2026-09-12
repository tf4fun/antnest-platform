use std::{net::Ipv4Addr, sync::Arc};

use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    extract::{
        MatchedPath, Path, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::{Request, StatusCode},
    middleware,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use opentelemetry::{global, propagation::Extractor};
use serde::{Deserialize, Serialize};
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::{
    application::{
        ControlError, ControlService, FailureContext, KernelCleanup, RuntimeNetworkAttachment,
    },
    domain::{AgentId, AttachmentState, NetworkState, PolicyAssignment, PolicyId, PolicyRevision},
    policy::PolicySpec,
    repository::Repository,
    telemetry::{EgressMetrics, capture_rpc_content_from_environment},
};

mod observation;
use observation::{
    CaptureHandle, Completion, ControlJson, RequestBody, rpc_scope, safe_identifier,
};

pub use crate::application::ServiceStatus;

const STATUS_ROUTE: &str = "/status";
const AGENT_NETWORK_ROUTE: &str = "/internal/agent-networks/{agent_id}";
const ATTACHMENT_ROUTE: &str = "/internal/agent-network-attachments/{agent_id}";
const RELEASE_ROUTE: &str = "/internal/agent-networks/{agent_id}/release";
const POLICY_REVISION_ROUTE: &str = "/internal/policies/{policy_id}/revisions/{revision}";
const POLICY_ASSIGNMENT_ROUTE: &str = "/internal/agent-policy-assignments/{agent_id}";

pub const CONTROL_ROUTES: &[(&str, &str)] = &[
    ("GET", STATUS_ROUTE),
    ("GET", AGENT_NETWORK_ROUTE),
    ("PUT", AGENT_NETWORK_ROUTE),
    ("PUT", ATTACHMENT_ROUTE),
    ("POST", RELEASE_ROUTE),
    ("PUT", POLICY_REVISION_ROUTE),
    ("GET", POLICY_REVISION_ROUTE),
    ("GET", POLICY_ASSIGNMENT_ROUTE),
    ("PUT", POLICY_ASSIGNMENT_ROUTE),
];

pub const CONTROL_ERROR_CODES: &[&str] = &[
    "invalid_request",
    "route_not_found",
    "agent_network_not_found",
    "policy_revision_not_found",
    "method_not_allowed",
    "agent_network_unavailable",
    "policy_revision_conflict",
    "resource_version_conflict",
    "address_pool_exhausted",
    "cleanup_failed",
    "operation_failed",
    "control_plane_unavailable",
];

#[async_trait]
trait ControlApi: Send + Sync {
    fn status(&self) -> ServiceStatus;
    async fn ensure(&self, agent_id: AgentId) -> Result<RuntimeNetworkAttachment, ControlError>;
    async fn network(&self, agent_id: &AgentId) -> Result<RuntimeNetworkAttachment, ControlError>;
    async fn set_attachment(
        &self,
        agent_id: AgentId,
        state: AttachmentState,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError>;
    async fn release(
        &self,
        agent_id: AgentId,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError>;
    async fn put_policy(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, ControlError>;
    async fn assignment(&self, agent_id: &AgentId) -> Result<PolicyAssignment, ControlError>;
    async fn policy(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, ControlError>;
    async fn assign(
        &self,
        agent_id: AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, ControlError>;
}

#[async_trait]
impl<R, K> ControlApi for ControlService<R, K>
where
    R: Repository,
    K: KernelCleanup,
{
    fn status(&self) -> ServiceStatus {
        ControlService::status(self)
    }

    async fn ensure(&self, agent_id: AgentId) -> Result<RuntimeNetworkAttachment, ControlError> {
        self.ensure_agent_network(agent_id).await
    }

    async fn network(&self, agent_id: &AgentId) -> Result<RuntimeNetworkAttachment, ControlError> {
        self.agent_network(agent_id).await
    }

    async fn set_attachment(
        &self,
        agent_id: AgentId,
        state: AttachmentState,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        self.set_runtime_attachment(agent_id, state, expected_resource_version)
            .await
    }

    async fn release(
        &self,
        agent_id: AgentId,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        self.release_agent_network(agent_id, expected_resource_version)
            .await
    }

    async fn put_policy(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, ControlError> {
        self.put_policy_revision(policy_id, revision, spec).await
    }

    async fn assignment(&self, agent_id: &AgentId) -> Result<PolicyAssignment, ControlError> {
        self.policy_assignment(agent_id).await
    }

    async fn policy(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, ControlError> {
        self.policy_revision(policy_id, revision).await
    }

    async fn assign(
        &self,
        agent_id: AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, ControlError> {
        self.assign_policy(agent_id, policy_id, revision, expected_resource_version)
            .await
    }
}

#[derive(Clone)]
struct AppState {
    api: Arc<dyn ControlApi>,
    metrics: EgressMetrics,
    capture_rpc_content: bool,
}

pub fn router<R, K>(service: Arc<ControlService<R, K>>, metrics: EgressMetrics) -> Router
where
    R: Repository,
    K: KernelCleanup,
{
    router_with_capture_rpc_content(service, metrics, capture_rpc_content_from_environment())
}

pub fn router_with_capture_rpc_content<R, K>(
    service: Arc<ControlService<R, K>>,
    metrics: EgressMetrics,
    capture_rpc_content: bool,
) -> Router
where
    R: Repository,
    K: KernelCleanup,
{
    let state = AppState {
        api: service,
        metrics,
        capture_rpc_content,
    };
    Router::new()
        .route(STATUS_ROUTE, get(status_handler))
        .route(AGENT_NETWORK_ROUTE, get(get_network).put(ensure_network))
        .route(ATTACHMENT_ROUTE, put(set_attachment))
        .route(RELEASE_ROUTE, post(release_network))
        .route(
            POLICY_REVISION_ROUTE,
            put(put_policy_revision).get(get_policy_revision),
        )
        .route(
            POLICY_ASSIGNMENT_ROUTE,
            get(get_assignment).put(assign_policy),
        )
        .fallback(route_not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(state.clone(), trace_request))
        .with_state(state)
}

async fn route_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "route_not_found",
        "route was not found",
        false,
    )
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "method is not allowed for this route",
        false,
    )
}

async fn trace_request(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let method = match request.method().as_str() {
        "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "CONNECT" | "TRACE" => {
            request.method().to_string()
        }
        _ => "_OTHER".to_owned(),
    };
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("unmatched")
        .to_owned();
    let parent = global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(request.headers()))
    });
    let span = tracing::info_span!(
        "egress.control",
        otel.name = format!("HTTP {method} {route}"),
        otel.kind = "server",
        "service.name" = crate::telemetry::SERVICE_NAME,
        "http.request.method" = %method,
        "http.route" = route,
        "http.response.status_code" = tracing::field::Empty,
        "http.server.request.duration_ms" = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        "error.type" = tracing::field::Empty,
        "failure.stage" = tracing::field::Empty,
        "failure.cause" = tracing::field::Empty,
        "antnest.agent.id" = tracing::field::Empty,
        "antnest.policy.id" = tracing::field::Empty,
        "antnest.policy.revision" = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        span_id = tracing::field::Empty,
    );
    if span.set_parent(parent).is_err() {
        tracing::debug!("incoming trace context was not attached");
    }
    crate::telemetry::record_span_identity(&span);
    span.set_attribute("network.protocol.name", "http");
    match request.version() {
        axum::http::Version::HTTP_10 => span.set_attribute("network.protocol.version", "1.0"),
        axum::http::Version::HTTP_11 => span.set_attribute("network.protocol.version", "1.1"),
        axum::http::Version::HTTP_2 => span.set_attribute("network.protocol.version", "2"),
        axum::http::Version::HTTP_3 => span.set_attribute("network.protocol.version", "3"),
        _ => {}
    }
    if let Some(operation) = control_operation(&method, &route) {
        span.set_attribute("rpc.service", "runtime-egress.control");
        span.set_attribute("rpc.method", operation);
    }
    let enabled = state.capture_rpc_content && control_operation(&method, &route).is_some();
    let capture = CaptureHandle::new();
    let completion = Completion::new(span.clone(), method, route, state.metrics, capture.clone());
    let (mut parts, body) = request.into_parts();
    parts.extensions.insert(capture.clone());
    let request = Request::from_parts(
        parts,
        Body::new(RequestBody {
            inner: body,
            capture,
        }),
    );
    let response = rpc_scope(enabled, next.run(request)).instrument(span).await;
    completion.respond(response)
}

fn control_operation(method: &str, route: &str) -> Option<&'static str> {
    match (method, route) {
        ("PUT", AGENT_NETWORK_ROUTE) => Some("ensure_agent_network"),
        ("GET", AGENT_NETWORK_ROUTE) => Some("agent_network"),
        ("PUT", ATTACHMENT_ROUTE) => Some("set_runtime_attachment"),
        ("POST", RELEASE_ROUTE) => Some("release_agent_network"),
        ("PUT", POLICY_REVISION_ROUTE) => Some("put_policy_revision"),
        ("GET", POLICY_REVISION_ROUTE) => Some("policy_revision"),
        ("GET", POLICY_ASSIGNMENT_ROUTE) => Some("policy_assignment"),
        ("PUT", POLICY_ASSIGNMENT_ROUTE) => Some("assign_policy"),
        _ => None,
    }
}

struct HeaderExtractor<'a>(&'a axum::http::HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(axum::http::HeaderName::as_str).collect()
    }
}

async fn status_handler(State(state): State<AppState>) -> Response {
    status_response(state.api.status())
}

fn status_response(status: ServiceStatus) -> Response {
    let failed = status.status != "ready";
    let mut response = axum::Json(status).into_response();
    if failed {
        response
            .extensions_mut()
            .insert(ControlErrorCode("service_not_ready"));
        response.extensions_mut().insert(SafeFailure {
            code: "service_not_ready",
            message: "Egress initialization or local readiness is incomplete",
            diagnostic: None,
        });
    }
    response
}

async fn ensure_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<ControlJson<NetworkResponse>, ApiError> {
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .ensure(agent_id)
        .await
        .map(NetworkResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

async fn get_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<ControlJson<NetworkResponse>, ApiError> {
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .network(&agent_id)
        .await
        .map(NetworkResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

async fn set_attachment(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<ControlJson<SetAttachmentRequest>, JsonRejection>,
) -> Result<ControlJson<NetworkResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    validate_resource_version(request.expected_resource_version)?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .set_attachment(agent_id, request.state, request.expected_resource_version)
        .await
        .map(NetworkResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SetAttachmentRequest {
    state: AttachmentState,
    expected_resource_version: u64,
}

async fn release_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<ControlJson<ExpectedResourceVersionRequest>, JsonRejection>,
) -> Result<ControlJson<NetworkResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    validate_resource_version(request.expected_resource_version)?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .release(agent_id, request.expected_resource_version)
        .await
        .map(NetworkResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExpectedResourceVersionRequest {
    expected_resource_version: u64,
}

fn validate_resource_version(resource_version: u64) -> Result<(), ApiError> {
    if resource_version == 0 {
        return Err(ApiError::invalid_request());
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PutPolicyRequest {
    spec: PolicySpec,
}

async fn put_policy_revision(
    State(state): State<AppState>,
    Path((policy_id, revision)): Path<(String, String)>,
    request: Result<ControlJson<PutPolicyRequest>, JsonRejection>,
) -> Result<ControlJson<PolicyRevisionResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    let policy_id = parse_policy_id(policy_id)?;
    let revision = parse_positive_revision(&revision)?;
    record_policy(&policy_id, revision);
    state
        .api
        .put_policy(policy_id, revision, request.spec)
        .await
        .map(PolicyRevisionResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

async fn get_policy_revision(
    State(state): State<AppState>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<ControlJson<PolicyRevisionDetailResponse>, ApiError> {
    let Path((policy_id, revision)) = path.map_err(|_| ApiError::invalid_request())?;
    let policy_id = parse_policy_id(policy_id)?;
    let revision = parse_positive_revision(&revision)?;
    record_policy(&policy_id, revision);
    state
        .api
        .policy(&policy_id, revision)
        .await
        .map(PolicyRevisionDetailResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

async fn get_assignment(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<ControlJson<AssignmentResponse>, ApiError> {
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .assignment(&agent_id)
        .await
        .map(AssignmentResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AssignPolicyRequest {
    policy_id: String,
    revision: u64,
    expected_resource_version: u64,
}

async fn assign_policy(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<ControlJson<AssignPolicyRequest>, JsonRejection>,
) -> Result<ControlJson<AssignmentResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    let agent_id = parse_agent_id(agent_id)?;
    let policy_id = parse_policy_id(request.policy_id)?;
    record_agent_id(&agent_id);
    record_policy(&policy_id, request.revision);
    state
        .api
        .assign(
            agent_id,
            policy_id,
            request.revision,
            request.expected_resource_version,
        )
        .await
        .map(AssignmentResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Serialize)]
struct NetworkResponse {
    agent_id: AgentId,
    tunnel_ipv4: Ipv4Addr,
    resolver_ipv4: Ipv4Addr,
    packet_contract_revision: u32,
    egress_endpoint: Ipv4EndpointResponse,
    state: NetworkState,
    network_resource_version: u64,
    attachment_state: AttachmentState,
    attachment_resource_version: u64,
}

#[derive(Serialize)]
struct Ipv4EndpointResponse {
    ipv4: Ipv4Addr,
    port: u16,
}

impl From<RuntimeNetworkAttachment> for NetworkResponse {
    fn from(value: RuntimeNetworkAttachment) -> Self {
        Self {
            agent_id: value.agent_id,
            tunnel_ipv4: value.tunnel_ipv4,
            resolver_ipv4: value.resolver_ipv4,
            packet_contract_revision: crate::packet::PACKET_CONTRACT_REVISION,
            egress_endpoint: Ipv4EndpointResponse {
                ipv4: *value.egress_endpoint.ip(),
                port: value.egress_endpoint.port(),
            },
            state: value.state,
            network_resource_version: value.network_resource_version,
            attachment_state: value.attachment_state,
            attachment_resource_version: value.attachment_resource_version,
        }
    }
}

#[derive(Serialize)]
struct PolicyRevisionResponse {
    policy_id: PolicyId,
    revision: u64,
    schema_version: u32,
    digest: String,
}

impl From<PolicyRevision> for PolicyRevisionResponse {
    fn from(value: PolicyRevision) -> Self {
        Self {
            policy_id: value.policy_id,
            revision: value.revision,
            schema_version: value.spec.schema_version(),
            digest: value.digest,
        }
    }
}

#[derive(Serialize)]
struct PolicyRevisionDetailResponse {
    policy_id: PolicyId,
    revision: u64,
    spec: PolicySpec,
    digest: String,
}

impl From<PolicyRevision> for PolicyRevisionDetailResponse {
    fn from(value: PolicyRevision) -> Self {
        Self {
            policy_id: value.policy_id,
            revision: value.revision,
            spec: value.spec,
            digest: value.digest,
        }
    }
}

#[derive(Serialize)]
struct AssignmentResponse {
    agent_id: AgentId,
    policy_id: PolicyId,
    revision: u64,
    resource_version: u64,
}

impl From<PolicyAssignment> for AssignmentResponse {
    fn from(value: PolicyAssignment) -> Self {
        Self {
            agent_id: value.agent_id,
            policy_id: value.policy_id,
            revision: value.revision,
            resource_version: value.resource_version,
        }
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    retryable: bool,
    diagnostic: Option<FailureContext>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ControlErrorCode(&'static str);

#[derive(Clone)]
struct SafeFailure {
    code: &'static str,
    message: &'static str,
    diagnostic: Option<FailureContext>,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl ApiError {
    fn invalid_request() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: "request validation failed",
            retryable: false,
            diagnostic: None,
        }
    }
}

impl From<ControlError> for ApiError {
    fn from(error: ControlError) -> Self {
        let diagnostic = error.diagnostic();
        let mut api = match error {
            ControlError::AgentNetworkNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "agent_network_not_found",
                "Agent network was not found",
                false,
            ),
            ControlError::PolicyRevisionNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "policy_revision_not_found",
                "policy revision was not found",
                false,
            ),
            ControlError::AgentNetworkUnavailable => Self::new(
                StatusCode::CONFLICT,
                "agent_network_unavailable",
                "Agent network is unavailable",
                false,
            ),
            ControlError::PolicyRevisionConflict => Self::new(
                StatusCode::CONFLICT,
                "policy_revision_conflict",
                "policy revision key has different content",
                false,
            ),
            ControlError::ResourceVersionConflict => Self::new(
                StatusCode::CONFLICT,
                "resource_version_conflict",
                "resource version changed",
                false,
            ),
            ControlError::AddressPoolExhausted => Self::new(
                StatusCode::CONFLICT,
                "address_pool_exhausted",
                "address pool is exhausted",
                false,
            ),
            ControlError::CleanupFailed(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "cleanup_failed",
                "data-plane cleanup did not complete",
                true,
            ),
            ControlError::OperationFailed(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "operation_failed",
                "control operation did not complete",
                true,
            ),
            ControlError::ControlPlaneUnavailable(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "control_plane_unavailable",
                "control plane is unavailable",
                true,
            ),
        };
        api.diagnostic = diagnostic;
        api
    }
}

impl ApiError {
    const fn new(
        status: StatusCode,
        code: &'static str,
        message: &'static str,
        retryable: bool,
    ) -> Self {
        Self {
            status,
            code,
            message,
            retryable,
            diagnostic: None,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            ControlJson(ErrorBody {
                code: self.code,
                message: self.message,
                retryable: self.retryable,
            }),
        )
            .into_response();
        response
            .extensions_mut()
            .insert(ControlErrorCode(self.code));
        response.extensions_mut().insert(SafeFailure {
            code: self.code,
            message: self.message,
            diagnostic: self.diagnostic.clone(),
        });
        if let Some(diagnostic) = self.diagnostic {
            response.extensions_mut().insert(diagnostic);
        }
        response
    }
}

fn parse_agent_id(value: String) -> Result<AgentId, ApiError> {
    AgentId::parse(value).map_err(|_| ApiError::invalid_request())
}

fn parse_policy_id(value: String) -> Result<PolicyId, ApiError> {
    PolicyId::parse(value).map_err(|_| ApiError::invalid_request())
}

fn parse_positive_revision(value: &str) -> Result<u64, ApiError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or_else(ApiError::invalid_request)
}

fn record_agent_id(agent_id: &AgentId) {
    if safe_identifier(agent_id.as_str()) {
        tracing::Span::current().record("antnest.agent.id", agent_id.as_str());
    }
}

fn record_policy(policy_id: &PolicyId, revision: u64) {
    let span = tracing::Span::current();
    if safe_identifier(policy_id.as_str()) {
        span.record("antnest.policy.id", policy_id.as_str());
    }
    span.record("antnest.policy.revision", revision.to_string());
}

#[cfg(test)]
mod tests {
    use axum::{http::StatusCode, response::IntoResponse};

    use super::{ApiError, CONTROL_ROUTES, ControlErrorCode};
    use crate::application::{ControlError, FailureContext};

    #[test]
    fn route_registry_includes_local_status_and_control_endpoints() {
        assert!(CONTROL_ROUTES.contains(&("GET", "/status")));
        assert!(CONTROL_ROUTES.contains(&("PUT", "/internal/agent-networks/{agent_id}")));
        assert!(CONTROL_ROUTES.contains(&("PUT", "/internal/agent-policy-assignments/{agent_id}")));
    }

    #[test]
    fn stable_error_code_is_available_to_control_telemetry() {
        let response = ApiError::invalid_request().into_response();
        assert_eq!(
            response.extensions().get::<ControlErrorCode>(),
            Some(&ControlErrorCode("invalid_request"))
        );
    }

    #[test]
    fn safe_failure_stage_and_cause_are_available_to_control_telemetry() {
        let diagnostic =
            FailureContext::new("assign_policy.kernel_cleanup", "kernel_command_failed");
        let response =
            ApiError::from(ControlError::CleanupFailed(diagnostic.clone())).into_response();

        assert_eq!(
            response.extensions().get::<FailureContext>(),
            Some(&diagnostic)
        );
        assert_eq!(
            response.extensions().get::<ControlErrorCode>(),
            Some(&ControlErrorCode("cleanup_failed"))
        );
    }

    #[test]
    fn scoped_repository_failure_has_a_retryable_stable_error() {
        let diagnostic =
            FailureContext::new("agent_network.repository", "repository_operation_failed");
        let response =
            ApiError::from(ControlError::OperationFailed(diagnostic.clone())).into_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.extensions().get::<FailureContext>(),
            Some(&diagnostic)
        );
        assert_eq!(
            response.extensions().get::<ControlErrorCode>(),
            Some(&ControlErrorCode("operation_failed"))
        );
    }
}
