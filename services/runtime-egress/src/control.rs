use std::{net::Ipv4Addr, sync::Arc, time::Instant};

use async_trait::async_trait;
use axum::{
    Json, Router,
    body::Body,
    extract::{MatchedPath, Path, State, rejection::JsonRejection},
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
    domain::{AgentId, NetworkState, PolicyAssignment, PolicyId, PolicyRevision},
    policy::PolicySpec,
    repository::Repository,
    telemetry::EgressMetrics,
};

pub use crate::application::ServiceStatus;

const STATUS_ROUTE: &str = "/status";
const AGENT_NETWORK_ROUTE: &str = "/internal/agent-networks/{agent_id}";
const FENCE_ROUTE: &str = "/internal/agent-networks/{agent_id}/fence";
const RESET_FLOWS_ROUTE: &str = "/internal/agent-networks/{agent_id}/reset-flows";
const RELEASE_ROUTE: &str = "/internal/agent-networks/{agent_id}/release";
const POLICY_REVISION_ROUTE: &str = "/internal/policies/{policy_id}/revisions/{revision}";
const POLICY_ASSIGNMENT_ROUTE: &str = "/internal/agent-policy-assignments/{agent_id}";

pub const CONTROL_ROUTES: &[(&str, &str)] = &[
    ("GET", STATUS_ROUTE),
    ("GET", AGENT_NETWORK_ROUTE),
    ("PUT", AGENT_NETWORK_ROUTE),
    ("POST", FENCE_ROUTE),
    ("POST", RESET_FLOWS_ROUTE),
    ("POST", RELEASE_ROUTE),
    ("PUT", POLICY_REVISION_ROUTE),
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
    async fn fence(
        &self,
        agent_id: AgentId,
        expected_resource_version: u64,
    ) -> Result<(), ControlError>;
    async fn reset(
        &self,
        agent_id: &AgentId,
        expected_resource_version: u64,
    ) -> Result<(), ControlError>;
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
        let result = self.ensure_agent_network(agent_id).await;
        self.observe_control_result(&result);
        result
    }

    async fn network(&self, agent_id: &AgentId) -> Result<RuntimeNetworkAttachment, ControlError> {
        let result = self.agent_network(agent_id).await;
        self.observe_control_result(&result);
        result
    }

    async fn fence(
        &self,
        agent_id: AgentId,
        expected_resource_version: u64,
    ) -> Result<(), ControlError> {
        let result = self.fence_agent(agent_id, expected_resource_version).await;
        self.observe_control_result(&result);
        result
    }

    async fn reset(
        &self,
        agent_id: &AgentId,
        expected_resource_version: u64,
    ) -> Result<(), ControlError> {
        let result = self
            .reset_agent_flows(agent_id, expected_resource_version)
            .await;
        self.observe_control_result(&result);
        result
    }

    async fn release(
        &self,
        agent_id: AgentId,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        let result = self
            .release_agent_network(agent_id, expected_resource_version)
            .await;
        self.observe_control_result(&result);
        result
    }

    async fn put_policy(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, ControlError> {
        let result = self.put_policy_revision(policy_id, revision, spec).await;
        self.observe_control_result(&result);
        result
    }

    async fn assignment(&self, agent_id: &AgentId) -> Result<PolicyAssignment, ControlError> {
        let result = self.policy_assignment(agent_id).await;
        self.observe_control_result(&result);
        result
    }

    async fn assign(
        &self,
        agent_id: AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, ControlError> {
        let result = self
            .assign_policy(agent_id, policy_id, revision, expected_resource_version)
            .await;
        self.observe_control_result(&result);
        result
    }
}

#[derive(Clone)]
struct AppState {
    api: Arc<dyn ControlApi>,
    metrics: EgressMetrics,
}

pub fn router<R, K>(service: Arc<ControlService<R, K>>, metrics: EgressMetrics) -> Router
where
    R: Repository,
    K: KernelCleanup,
{
    let state = AppState {
        api: service,
        metrics,
    };
    Router::new()
        .route(STATUS_ROUTE, get(status_handler))
        .route(AGENT_NETWORK_ROUTE, get(get_network).put(ensure_network))
        .route(FENCE_ROUTE, post(fence_network))
        .route(RESET_FLOWS_ROUTE, post(reset_flows))
        .route(RELEASE_ROUTE, post(release_network))
        .route(POLICY_REVISION_ROUTE, put(put_policy_revision))
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
    let method = request.method().clone();
    let is_control_request = request.uri().path().starts_with("/internal/");
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("unmatched")
        .to_owned();
    if !is_business_control_route(&route) && !is_control_request {
        return next.run(request).await;
    }
    let parent = global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(request.headers()))
    });
    let span = tracing::info_span!(
        "egress.control",
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
    if let Err(error) = span.set_parent(parent) {
        tracing::debug!(?error, "incoming trace context was not attached");
    }
    crate::telemetry::record_span_identity(&span);
    let started = Instant::now();
    let response = next.run(request).instrument(span.clone()).await;
    let status = response.status();
    let error_type = response
        .extensions()
        .get::<ControlErrorCode>()
        .map_or("", |code| code.0);
    let diagnostic = response.extensions().get::<FailureContext>().copied();
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let outcome = if status.is_success() {
        "success"
    } else {
        "error"
    };
    state.metrics.control(
        method.as_str(),
        &route,
        status.as_u16(),
        outcome,
        error_type,
        started.elapsed(),
    );
    span.record("http.response.status_code", status.as_u16());
    span.record("http.server.request.duration_ms", duration_ms);
    span.record(
        "otel.status_code",
        if status.is_client_error() || status.is_server_error() {
            "ERROR"
        } else {
            "OK"
        },
    );
    span.record("error.type", error_type);
    if let Some(diagnostic) = diagnostic {
        span.record("failure.stage", diagnostic.stage);
        span.record("failure.cause", diagnostic.cause);
    }
    span.in_scope(|| {
        tracing::info!(
            http.request.method = %method,
            http.route = route,
            http.response.status_code = status.as_u16(),
            http.server.request.duration_ms = duration_ms,
            error.type = error_type,
            failure.stage = diagnostic.map_or("", |value| value.stage),
            failure.cause = diagnostic.map_or("", |value| value.cause),
            "Runtime Egress control request completed"
        );
    });
    response
}

fn is_business_control_route(route: &str) -> bool {
    route.starts_with("/internal/")
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

async fn status_handler(State(state): State<AppState>) -> Json<ServiceStatus> {
    Json(state.api.status())
}

async fn ensure_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<NetworkResponse>, ApiError> {
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .ensure(agent_id)
        .await
        .map(NetworkResponse::from)
        .map(Json)
        .map_err(ApiError::from)
}

async fn get_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<NetworkResponse>, ApiError> {
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .network(&agent_id)
        .await
        .map(NetworkResponse::from)
        .map(Json)
        .map_err(ApiError::from)
}

async fn fence_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<Json<ExpectedResourceVersionRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(request) = request.map_err(|_| ApiError::invalid_request())?;
    validate_resource_version(request.expected_resource_version)?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .fence(agent_id, request.expected_resource_version)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(ApiError::from)
}

async fn reset_flows(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<Json<ExpectedResourceVersionRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let Json(request) = request.map_err(|_| ApiError::invalid_request())?;
    validate_resource_version(request.expected_resource_version)?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .reset(&agent_id, request.expected_resource_version)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(ApiError::from)
}

async fn release_network(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<Json<ExpectedResourceVersionRequest>, JsonRejection>,
) -> Result<Json<NetworkResponse>, ApiError> {
    let Json(request) = request.map_err(|_| ApiError::invalid_request())?;
    validate_resource_version(request.expected_resource_version)?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .release(agent_id, request.expected_resource_version)
        .await
        .map(NetworkResponse::from)
        .map(Json)
        .map_err(ApiError::from)
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutPolicyRequest {
    spec: PolicySpec,
}

async fn put_policy_revision(
    State(state): State<AppState>,
    Path((policy_id, revision)): Path<(String, String)>,
    request: Result<Json<PutPolicyRequest>, JsonRejection>,
) -> Result<Json<PolicyRevisionResponse>, ApiError> {
    let Json(request) = request.map_err(|_| ApiError::invalid_request())?;
    let policy_id = parse_policy_id(policy_id)?;
    let revision = parse_positive_revision(&revision)?;
    record_policy(&policy_id, revision);
    state
        .api
        .put_policy(policy_id, revision, request.spec)
        .await
        .map(PolicyRevisionResponse::from)
        .map(Json)
        .map_err(ApiError::from)
}

async fn get_assignment(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
) -> Result<Json<AssignmentResponse>, ApiError> {
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .assignment(&agent_id)
        .await
        .map(AssignmentResponse::from)
        .map(Json)
        .map_err(ApiError::from)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssignPolicyRequest {
    policy_id: String,
    revision: u64,
    expected_resource_version: u64,
}

async fn assign_policy(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    request: Result<Json<AssignPolicyRequest>, JsonRejection>,
) -> Result<Json<AssignmentResponse>, ApiError> {
    let Json(request) = request.map_err(|_| ApiError::invalid_request())?;
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
        .map(Json)
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
                "policy assignment changed",
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
            Json(ErrorBody {
                code: self.code,
                message: self.message,
                retryable: self.retryable,
            }),
        )
            .into_response();
        response
            .extensions_mut()
            .insert(ControlErrorCode(self.code));
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
    tracing::Span::current().record("antnest.agent.id", agent_id.as_str());
}

fn record_policy(policy_id: &PolicyId, revision: u64) {
    let span = tracing::Span::current();
    span.record("antnest.policy.id", policy_id.as_str());
    span.record("antnest.policy.revision", revision);
}

#[cfg(test)]
mod tests {
    use axum::{http::StatusCode, response::IntoResponse};

    use super::{ApiError, ControlErrorCode, is_business_control_route};
    use crate::application::{ControlError, FailureContext};

    #[test]
    fn otlp_route_boundary_excludes_operational_endpoints() {
        assert!(is_business_control_route(
            "/internal/agent-networks/{agent_id}"
        ));
        assert!(is_business_control_route(
            "/internal/agent-policy-assignments/{agent_id}"
        ));
        assert!(!is_business_control_route("/status"));
        assert!(!is_business_control_route("unmatched"));
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
        let response = ApiError::from(ControlError::CleanupFailed(diagnostic)).into_response();

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
        let response = ApiError::from(ControlError::OperationFailed(diagnostic)).into_response();

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
