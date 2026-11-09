use std::{error::Error as _, net::Ipv4Addr, sync::Arc, time::Duration};

use crate::tunnel::Registration;
use antnest_runtime_tunnel::KeyId;
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{FromRequestParts, MatchedPath, Path, State, rejection::JsonRejection},
    http::{Request, StatusCode, request::Parts},
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
    domain::{
        AgentId, AttachmentState, NetworkState, PolicyAssignment, PolicyId, PolicyRevision,
        StoredVersion,
    },
    policy::PolicySpec,
    repository::Repository,
    service_auth::{
        Admission, AdmissionError, MAX_JSON_BYTES, SERVICE_HEADER, valid_json_body,
        valid_json_media,
    },
    telemetry::{EgressMetrics, capture_rpc_content_from_environment},
};

mod observation;
use observation::{
    CaptureHandle, Completion, ControlJson, RequestBody, rpc_scope, safe_identifier,
};

pub use crate::application::ServiceStatus;

pub(crate) const TUNNEL_KEY_ROUTE: &str = "/internal/agent-tunnel-keys/{agent_id}";
const STATUS_ROUTE: &str = "/status";
const AGENT_NETWORK_ROUTE: &str = "/internal/agent-networks/{agent_id}";
const ATTACHMENT_ROUTE: &str = "/internal/agent-network-attachments/{agent_id}";
const RELEASE_ROUTE: &str = "/internal/agent-networks/{agent_id}/release";
const POLICY_REVISION_ROUTE: &str = "/internal/policies/{policy_id}/revisions/{revision}";
const POLICY_ASSIGNMENT_ROUTE: &str = "/internal/agent-policy-assignments/{agent_id}";

pub const CONTROL_ROUTES: &[(&str, &str)] = &[
    ("PUT", TUNNEL_KEY_ROUTE),
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
    crate::api_errors_gen::SERVICE_UNAUTHENTICATED,
    crate::api_errors_gen::CALLER_NOT_ALLOWED,
    crate::api_errors_gen::UNSUPPORTED_MEDIA_TYPE,
    crate::api_errors_gen::INVALID_REQUEST,
    crate::api_errors_gen::ROUTE_NOT_FOUND,
    crate::api_errors_gen::AGENT_NETWORK_NOT_FOUND,
    crate::api_errors_gen::POLICY_REVISION_NOT_FOUND,
    crate::api_errors_gen::METHOD_NOT_ALLOWED,
    crate::api_errors_gen::AGENT_NETWORK_UNAVAILABLE,
    crate::api_errors_gen::POLICY_REVISION_CONFLICT,
    crate::api_errors_gen::RESOURCE_VERSION_CONFLICT,
    crate::api_errors_gen::ADDRESS_POOL_EXHAUSTED,
    crate::api_errors_gen::CLEANUP_FAILED,
    crate::api_errors_gen::OPERATION_FAILED,
    crate::api_errors_gen::CONTROL_PLANE_UNAVAILABLE,
    crate::api_errors_gen::TUNNEL_KEY_UNAVAILABLE,
    crate::api_errors_gen::TUNNEL_KEY_CONFLICT,
    crate::api_errors_gen::ATTACHMENT_OPEN,
    crate::api_errors_gen::INTERNAL,
];

#[async_trait]
trait ControlApi: Send + Sync {
    async fn register_tunnel(
        &self,
        agent: AgentId,
        input: Registration,
    ) -> Result<(), ControlError>;
    fn status(&self) -> ServiceStatus;
    async fn ensure(&self, agent_id: AgentId) -> Result<RuntimeNetworkAttachment, ControlError>;
    async fn network(&self, agent_id: &AgentId) -> Result<RuntimeNetworkAttachment, ControlError>;

    async fn set_attachment(
        &self,
        agent_id: AgentId,
        state: AttachmentState,
        expected_resource_version: u64,
        runtime_endpoint: Option<Ipv4Addr>,
        tunnel_key_id: Option<KeyId>,
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
    async fn register_tunnel(
        &self,
        agent: AgentId,
        input: Registration,
    ) -> Result<(), ControlError> {
        ControlService::register_tunnel(self, agent, input).await
    }
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
        runtime_endpoint: Option<Ipv4Addr>,
        tunnel_key_id: Option<KeyId>,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        self.set_runtime_attachment(
            agent_id,
            state,
            expected_resource_version,
            runtime_endpoint,
            tunnel_key_id,
        )
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

pub fn router<R, K>(
    service: Arc<ControlService<R, K>>,
    metrics: EgressMetrics,
    admission: Admission,
) -> Router
where
    R: Repository,
    K: KernelCleanup,
{
    router_with_capture_rpc_content(
        service,
        metrics,
        admission,
        capture_rpc_content_from_environment(),
    )
}

pub fn router_with_capture_rpc_content<R, K>(
    service: Arc<ControlService<R, K>>,
    metrics: EgressMetrics,
    admission: Admission,
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
        .route(AGENT_NETWORK_ROUTE, get(get_network).put(ensure_network))
        .route(ATTACHMENT_ROUTE, put(set_attachment))
        .route(TUNNEL_KEY_ROUTE, put(register_tunnel))
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
        .layer(middleware::from_fn_with_state(
            Arc::new(admission),
            admit_request,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), trace_request))
        .with_state(state)
}

pub fn health_router<R, K>(service: Arc<ControlService<R, K>>, metrics: EgressMetrics) -> Router
where
    R: Repository,
    K: KernelCleanup,
{
    let state = AppState {
        api: service,
        metrics,
        capture_rpc_content: false,
    };
    Router::new()
        .route(STATUS_ROUTE, get(status_handler))
        .fallback(route_not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(health_request))
        .layer(middleware::from_fn_with_state(state.clone(), trace_request))
        .with_state(state)
}

async fn admit_request(
    State(admission): State<Arc<Admission>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if let Err(error) = admission.authorize_request(&request) {
        return match error {
            AdmissionError::Unauthenticated => ApiError::new(
                StatusCode::UNAUTHORIZED,
                crate::api_errors_gen::SERVICE_UNAUTHENTICATED,
                "service authentication failed",
                false,
            ),
            AdmissionError::Forbidden => ApiError::new(
                StatusCode::FORBIDDEN,
                crate::api_errors_gen::CALLER_NOT_ALLOWED,
                "caller is not allowed",
                false,
            ),
        }
        .into_response();
    }
    let carriers = request
        .headers()
        .keys()
        .filter(|name| {
            matches!(
                name.as_str(),
                "authorization" | "cookie" | "antnest-caller-context" | SERVICE_HEADER
            ) || name.as_str().starts_with("x-antnest-")
        })
        .cloned()
        .collect::<Vec<_>>();
    for name in carriers {
        request.headers_mut().remove(name);
    }
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str);
    let Some(route) = route else {
        return next.run(request).await;
    };
    if control_operation(request.method().as_str(), route).is_none() {
        // In particular, Axum's implicit HEAD on GET must not create a ninth
        // business method outside the exact Controller route contract.
        return method_not_allowed().await.into_response();
    }
    if request.uri().query().is_some() {
        return ApiError::invalid_request().into_response();
    }
    let json = request.method() != axum::http::Method::GET
        && !(request.method() == axum::http::Method::PUT && route == AGENT_NETWORK_ROUTE);
    if json && !json_media(&request) {
        return ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            crate::api_errors_gen::UNSUPPORTED_MEDIA_TYPE,
            "JSON media type is required",
            false,
        )
        .into_response();
    }
    match bounded_body(request, json).await {
        Ok(request) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

fn json_media(request: &Request<Body>) -> bool {
    let content_types = request
        .headers()
        .get_all("content-type")
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>();
    let Ok(content_types) = content_types else {
        return false;
    };
    let encodings = request
        .headers()
        .get_all("content-encoding")
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>();
    let Ok(encodings) = encodings else {
        return false;
    };
    valid_json_media(&content_types)
        && (encodings.is_empty()
            || matches!(encodings.as_slice(), [value] if value.eq_ignore_ascii_case("identity")))
}

async fn bounded_body(request: Request<Body>, json: bool) -> Result<Request<Body>, ApiError> {
    let (parts, body) = request.into_parts();
    let limit = if json { MAX_JSON_BYTES } else { 0 };
    let bytes = tokio::time::timeout(Duration::from_secs(5), to_bytes(body, limit))
        .await
        .map_err(|_| ApiError::invalid_request())?
        .map_err(|error| {
            if json
                && error
                    .source()
                    .is_some_and(|source| source.is::<http_body_util::LengthLimitError>())
            {
                ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    crate::api_errors_gen::INVALID_REQUEST,
                    "request body is too large",
                    false,
                )
            } else {
                ApiError::invalid_request()
            }
        })?;
    if json && !valid_json_body(&bytes) {
        return Err(ApiError::invalid_request());
    }
    Ok(Request::from_parts(parts, Body::from(bytes)))
}

async fn health_request(request: Request<Body>, next: Next) -> Response {
    if request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        == Some(STATUS_ROUTE)
    {
        if request.uri().query().is_some() {
            return ApiError::invalid_request().into_response();
        }
        return match bounded_body(request, false).await {
            Ok(request) => next.run(request).await,
            Err(error) => error.into_response(),
        };
    }
    next.run(request).await
}

async fn route_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        crate::api_errors_gen::ROUTE_NOT_FOUND,
        "route was not found",
        false,
    )
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        crate::api_errors_gen::METHOD_NOT_ALLOWED,
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
    let enabled = state.capture_rpc_content
        && route != TUNNEL_KEY_ROUTE
        && control_operation(&method, &route).is_some();
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
        ("PUT", TUNNEL_KEY_ROUTE) => Some("register_tunnel"),
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
            .insert(ControlErrorCode(crate::api_errors_gen::SERVICE_NOT_READY));
        response.extensions_mut().insert(SafeFailure {
            code: crate::api_errors_gen::SERVICE_NOT_READY,
            message: "Egress initialization or local readiness is incomplete",
            diagnostic: None,
        });
    }
    response
}

struct ControlPath<T>(T);

impl<S, T> FromRequestParts<S> for ControlPath<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned + Send,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Path(value) = Path::<T>::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::invalid_request())?;
        Ok(Self(value))
    }
}

async fn ensure_network(
    State(state): State<AppState>,
    ControlPath(agent_id): ControlPath<String>,
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
    ControlPath(agent_id): ControlPath<String>,
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

async fn register_tunnel(
    State(state): State<AppState>,
    ControlPath(agent): ControlPath<String>,
    request: Result<ControlJson<Registration>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let ControlJson(input) = request.map_err(|_| ApiError::invalid_request())?;
    let agent = parse_agent_id(agent)?;
    state
        .api
        .register_tunnel(agent, input)
        .await
        .map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_attachment(
    State(state): State<AppState>,
    ControlPath(agent_id): ControlPath<String>,
    headers: axum::http::HeaderMap,
    request: Result<ControlJson<SetAttachmentRequest>, JsonRejection>,
) -> Result<ControlJson<NetworkResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    let expected = resolve_resource_version(
        request.expected_version,
        request.expected_resource_version,
        &headers,
    )?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .set_attachment(
            agent_id,
            request.state,
            expected,
            request.runtime_endpoint,
            request
                .tunnel_key_id
                .as_deref()
                .map(KeyId::parse)
                .transpose()
                .map_err(|_| ApiError::invalid_request())?,
        )
        .await
        .map(NetworkResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SetAttachmentRequest {
    tunnel_key_id: Option<String>,
    state: AttachmentState,
    #[serde(
        default,
        deserialize_with = "present_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    expected_version: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    expected_resource_version: Option<u64>,
    runtime_endpoint: Option<Ipv4Addr>,
}

async fn release_network(
    State(state): State<AppState>,
    ControlPath(agent_id): ControlPath<String>,
    headers: axum::http::HeaderMap,
    request: Result<ControlJson<ExpectedResourceVersionRequest>, JsonRejection>,
) -> Result<ControlJson<NetworkResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    let expected = resolve_resource_version(
        request.expected_version,
        request.expected_resource_version,
        &headers,
    )?;
    let agent_id = parse_agent_id(agent_id)?;
    record_agent_id(&agent_id);
    state
        .api
        .release(agent_id, expected)
        .await
        .map(NetworkResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExpectedResourceVersionRequest {
    #[serde(
        default,
        deserialize_with = "present_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    expected_version: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    expected_resource_version: Option<u64>,
}

fn present_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn parse_quoted_version(header: &str) -> Result<String, ApiError> {
    let bytes = header.as_bytes();
    if bytes.len() < 3 || bytes.len() > 130 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return Err(ApiError::invalid_request());
    }
    let inner = &header[1..header.len() - 1];
    if inner
        .bytes()
        .any(|b| b == b'"' || b == b'\\' || b <= 0x20 || b == 0x7f)
    {
        return Err(ApiError::invalid_request());
    }
    Ok(inner.to_owned())
}

fn parse_resource_version_token(token: &str) -> Result<u64, ApiError> {
    let bytes = token.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 20
        || bytes[0] == b'0'
        || !token.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ApiError::invalid_request());
    }
    parse_stored_version(token)
}

fn resolve_resource_version(
    canonical: Option<String>,
    legacy: Option<u64>,
    headers: &axum::http::HeaderMap,
) -> Result<u64, ApiError> {
    let values = headers.get_all(axum::http::header::IF_MATCH);
    let mut iter = values.iter();
    let header = match (iter.next(), iter.next()) {
        (None, None) => None,
        (Some(value), None) => Some(parse_quoted_version(
            value.to_str().map_err(|_| ApiError::invalid_request())?,
        )?),
        _ => return Err(ApiError::invalid_request()),
    };
    let forms = canonical.is_some() as u8 + legacy.is_some() as u8 + header.is_some() as u8;
    if forms != 1 {
        return Err(ApiError::invalid_request());
    }
    if let Some(version) = legacy {
        return validate_stored_version(version);
    }
    let token = canonical.or(header).ok_or_else(ApiError::invalid_request)?;
    parse_resource_version_token(&token)
}

fn validate_stored_version(value: u64) -> Result<u64, ApiError> {
    StoredVersion::new(value)
        .map(StoredVersion::get)
        .ok_or_else(ApiError::invalid_request)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PutPolicyRequest {
    spec: PolicySpec,
}

async fn put_policy_revision(
    State(state): State<AppState>,
    ControlPath((policy_id, revision)): ControlPath<(String, String)>,
    request: Result<ControlJson<PutPolicyRequest>, JsonRejection>,
) -> Result<ControlJson<PolicyRevisionResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    let policy_id = parse_policy_id(policy_id)?;
    let revision = parse_stored_version(&revision)?;
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
    ControlPath((policy_id, revision)): ControlPath<(String, String)>,
) -> Result<ControlJson<PolicyRevisionDetailResponse>, ApiError> {
    let policy_id = parse_policy_id(policy_id)?;
    let revision = parse_stored_version(&revision)?;
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
    ControlPath(agent_id): ControlPath<String>,
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
    #[serde(
        default,
        deserialize_with = "present_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    expected_version: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    expected_resource_version: Option<u64>,
}

async fn assign_policy(
    State(state): State<AppState>,
    ControlPath(agent_id): ControlPath<String>,
    headers: axum::http::HeaderMap,
    request: Result<ControlJson<AssignPolicyRequest>, JsonRejection>,
) -> Result<ControlJson<AssignmentResponse>, ApiError> {
    let ControlJson(request) = request.map_err(|_| ApiError::invalid_request())?;
    let expected = resolve_resource_version(
        request.expected_version,
        request.expected_resource_version,
        &headers,
    )?;
    let agent_id = parse_agent_id(agent_id)?;
    let policy_id = parse_policy_id(request.policy_id)?;
    let revision = validate_stored_version(request.revision)?;
    record_agent_id(&agent_id);
    record_policy(&policy_id, revision);
    state
        .api
        .assign(agent_id, policy_id, revision, expected)
        .await
        .map(AssignmentResponse::from)
        .map(ControlJson)
        .map_err(ApiError::from)
}

#[derive(Serialize)]
struct NetworkResponse {
    tunnel_key_id: Option<String>,
    agent_id: AgentId,
    tunnel_ipv4: Ipv4Addr,
    resolver_ipv4: Ipv4Addr,
    packet_contract_revision: u32,
    egress_endpoint: Ipv4EndpointResponse,
    state: NetworkState,
    network_resource_version: u64,
    attachment_state: AttachmentState,
    attachment_resource_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_endpoint: Option<Ipv4Addr>,
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
            runtime_endpoint: value.runtime_endpoint,
            tunnel_key_id: value.tunnel_key_id.map(|id| id.to_string()),
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

impl ApiError {
    fn invalid_request() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: crate::api_errors_gen::INVALID_REQUEST,
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
            ControlError::InvalidRequest => Self::invalid_request(),
            ControlError::TunnelKeyUnavailable => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::TUNNEL_KEY_UNAVAILABLE,
                "prepared tunnel key unavailable",
                false,
            ),
            ControlError::TunnelKeyConflict => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::TUNNEL_KEY_CONFLICT,
                "prepared tunnel key conflicts",
                false,
            ),
            ControlError::AttachmentOpen => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::ATTACHMENT_OPEN,
                "close attachment before preparing new tunnel key",
                false,
            ),
            ControlError::AgentNetworkNotFound => Self::new(
                StatusCode::NOT_FOUND,
                crate::api_errors_gen::AGENT_NETWORK_NOT_FOUND,
                "Agent network was not found",
                false,
            ),
            ControlError::PolicyRevisionNotFound => Self::new(
                StatusCode::NOT_FOUND,
                crate::api_errors_gen::POLICY_REVISION_NOT_FOUND,
                "policy revision was not found",
                false,
            ),
            ControlError::AgentNetworkUnavailable => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::AGENT_NETWORK_UNAVAILABLE,
                "Agent network is unavailable",
                false,
            ),
            ControlError::PolicyRevisionConflict => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::POLICY_REVISION_CONFLICT,
                "policy revision key has different content",
                false,
            ),
            ControlError::ResourceVersionConflict => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::RESOURCE_VERSION_CONFLICT,
                "resource version changed",
                false,
            ),
            ControlError::AddressPoolExhausted => Self::new(
                StatusCode::CONFLICT,
                crate::api_errors_gen::ADDRESS_POOL_EXHAUSTED,
                "address pool is exhausted",
                false,
            ),
            ControlError::CleanupFailed(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                crate::api_errors_gen::CLEANUP_FAILED,
                "data-plane cleanup did not complete",
                true,
            ),
            ControlError::OperationFailed(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                crate::api_errors_gen::OPERATION_FAILED,
                "control operation did not complete",
                true,
            ),
            ControlError::ControlPlaneUnavailable(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                crate::api_errors_gen::CONTROL_PLANE_UNAVAILABLE,
                "control plane is unavailable",
                true,
            ),
            ControlError::Internal(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                crate::api_errors_gen::INTERNAL,
                "Internal service error",
                false,
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
        let (code, message, retryable) = match crate::api_errors_gen::metadata(self.code) {
            Some(_) => (self.code, self.message, self.retryable),
            None => (
                crate::api_errors_gen::INTERNAL,
                "Internal service error",
                false,
            ),
        };
        let envelope = crate::api_errors_gen::envelope(code, message, "", retryable);
        let request_id = envelope["request_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let mut response = (self.status, ControlJson(envelope)).into_response();
        if let Ok(value) = axum::http::HeaderValue::from_str(&request_id) {
            response.headers_mut().insert("x-request-id", value);
        }
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        if code == crate::api_errors_gen::SERVICE_UNAUTHENTICATED {
            response.headers_mut().insert(
                "www-authenticate",
                axum::http::HeaderValue::from_static("Bearer realm=\"antnest-service\""),
            );
        }
        response.extensions_mut().insert(ControlErrorCode(code));
        response.extensions_mut().insert(SafeFailure {
            code,
            message,
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

fn parse_stored_version(value: &str) -> Result<u64, ApiError> {
    let version = value
        .parse::<u64>()
        .map_err(|_| ApiError::invalid_request())?;
    validate_stored_version(version)
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

    use super::{
        ApiError, CONTROL_ROUTES, ControlErrorCode, parse_resource_version_token,
        parse_stored_version,
    };
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
            Some(&ControlErrorCode(crate::api_errors_gen::INVALID_REQUEST))
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
            Some(&ControlErrorCode(crate::api_errors_gen::CLEANUP_FAILED))
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
            Some(&ControlErrorCode(crate::api_errors_gen::OPERATION_FAILED))
        );
    }

    #[test]
    fn stored_version_parse_stored_version_bounds() {
        for accepted in ["1", "9223372036854775807"] {
            assert!(parse_stored_version(accepted).is_ok(), "{accepted}");
        }
        for rejected in [
            "0",
            "9223372036854775808",
            "18446744073709551615",
            "-1",
            "abc",
        ] {
            let error =
                parse_stored_version(rejected).expect_err(&format!("{rejected} must be rejected"));
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{rejected}");
            assert_eq!(error.code, crate::api_errors_gen::INVALID_REQUEST);
            assert!(!error.retryable, "{rejected}");
        }
    }

    #[test]
    fn stored_version_resource_version_token_bounds() {
        for accepted in ["1", "9223372036854775807"] {
            assert!(parse_resource_version_token(accepted).is_ok(), "{accepted}");
        }
        for rejected in [
            "0",
            "9223372036854775808",
            "18446744073709551615",
            "-1",
            "abc",
            "01",
            "+1",
        ] {
            let error = parse_resource_version_token(rejected)
                .expect_err(&format!("{rejected} must be rejected"));
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{rejected}");
            assert_eq!(error.code, crate::api_errors_gen::INVALID_REQUEST);
            assert!(!error.retryable, "{rejected}");
        }
    }
}

#[cfg(test)]
#[path = "control/common_error_tests.rs"]
mod common_error_tests;

#[cfg(test)]
#[path = "control/golden_tests.rs"]
mod golden_tests;
