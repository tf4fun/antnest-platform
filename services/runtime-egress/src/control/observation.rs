use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Instant,
};

use super::{ControlErrorCode, SafeFailure};
use crate::telemetry::EgressMetrics;
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{FromRequest, Request, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use http_body::{Body as _, Frame, SizeHint};
use opentelemetry::{
    Array, KeyValue, Value,
    trace::{Status, TraceContextExt as _},
};
use serde::{Serialize, de::DeserializeOwned};
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

tokio::task_local! { static CAPTURE_RPC: bool; }

pub(super) async fn rpc_scope<F: Future>(enabled: bool, future: F) -> F::Output {
    CAPTURE_RPC.scope(enabled, future).await
}

fn rpc_content(direction: &'static str, value: &impl Serialize) {
    if !CAPTURE_RPC.try_with(|enabled| *enabled).unwrap_or(false) {
        return;
    }
    let span = tracing::Span::current();
    if span.is_disabled() {
        return;
    }
    match serde_json::to_string(value) {
        Ok(json) => span.add_event(direction, vec![KeyValue::new("antnest.payload.json", json)]),
        Err(_) => span.add_event(
            "antnest.capture.error",
            vec![KeyValue::new("error.type", "json_encoding")],
        ),
    }
}

pub(super) fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

pub(super) struct ControlJson<T>(pub T);

impl<T, S> FromRequest<S> for ControlJson<T>
where
    T: DeserializeOwned + Serialize,
    S: Send + Sync,
{
    type Rejection = JsonRejection;
    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(value) = Json::<T>::from_request(request, state).await?;
        rpc_content("antnest.request", &value);
        Ok(Self(value))
    }
}

impl<T: Serialize> IntoResponse for ControlJson<T> {
    fn into_response(self) -> Response {
        rpc_content("antnest.response", &self.0);
        Json(self.0).into_response()
    }
}

#[derive(Clone)]
pub(super) struct CaptureHandle(Arc<Mutex<CaptureState>>);

#[derive(Clone, Default)]
struct CaptureState {
    observed: u64,
    failed: bool,
}

impl CaptureHandle {
    pub(super) fn new() -> Self {
        Self(Arc::new(Mutex::new(CaptureState::default())))
    }

    fn update(&self, f: impl FnOnce(&mut CaptureState)) {
        if let Ok(mut state) = self.0.lock() {
            f(&mut state);
        }
    }

    fn snapshot(&self) -> CaptureState {
        match self.0.lock() {
            Ok(state) => state.clone(),
            Err(_) => CaptureState {
                failed: true,
                ..CaptureState::default()
            },
        }
    }
}

pub(super) struct RequestBody {
    pub(super) inner: Body,
    pub(super) capture: CaptureHandle,
}

impl http_body::Body for RequestBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.inner).poll_frame(cx);
        self.capture.update(|state| match &result {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref() {
                    state.observed = state.observed.saturating_add(bytes.len() as u64);
                }
            }
            Poll::Ready(None) => {}
            Poll::Ready(Some(Err(_))) => state.failed = true,
            Poll::Pending => {}
        });
        result
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

pub(super) struct Completion {
    span: Option<tracing::Span>,
    method: String,
    route: String,
    metrics: EgressMetrics,
    capture: CaptureHandle,
    started: Instant,
    status: Option<StatusCode>,

    observed: u64,
    error_code: &'static str,
    failure: Option<SafeFailure>,
}

impl Completion {
    pub(super) fn new(
        span: tracing::Span,
        method: String,
        route: String,
        metrics: EgressMetrics,
        capture: CaptureHandle,
    ) -> Self {
        Self {
            span: Some(span),
            method,
            route,
            metrics,
            capture,
            started: Instant::now(),
            status: None,

            observed: 0,
            error_code: "",
            failure: None,
        }
    }

    pub(super) fn respond(mut self, response: Response) -> Response {
        self.status = Some(response.status());
        self.error_code = response
            .extensions()
            .get::<ControlErrorCode>()
            .map_or("", |code| code.0);
        self.failure = response.extensions().get::<SafeFailure>().cloned();

        if let Some(span) = &self.span {
            span.set_attribute(
                "http.response.status_code",
                i64::from(response.status().as_u16()),
            );
        }
        let (parts, body) = response.into_parts();
        if body.is_end_stream() {
            self.finish("eof");
            return Response::from_parts(parts, body);
        }
        Response::from_parts(
            parts,
            Body::new(ResponseBody {
                inner: body,
                completion: self,
            }),
        )
    }

    fn finish(&mut self, termination: &'static str) {
        let Some(span) = self.span.take() else {
            return;
        };
        let request = self.capture.snapshot();
        let request_fault = request.failed;
        let transport_fault = termination == "body_error" || request_fault;
        let cancelled = termination == "cancelled";
        let panic = termination == "panic";
        let status = self.status;
        let rejected = status.is_some_and(|status| status.is_client_error());
        let failed = transport_fault
            || panic
            || status.is_some_and(|status| status.is_server_error())
            || (!self.error_code.is_empty() && !rejected);
        let outcome = if panic || transport_fault {
            "error"
        } else if cancelled {
            "cancelled"
        } else if rejected {
            "rejected"
        } else if failed {
            "error"
        } else {
            "success"
        };
        let code = if panic {
            "handler_panic"
        } else if termination == "body_error" {
            "response_body_error"
        } else if request_fault {
            "request_body_error"
        } else if self.error_code.is_empty() && rejected {
            "http_request_rejected"
        } else if self.error_code.is_empty() && failed {
            "http_server_error"
        } else {
            self.error_code
        };
        span.set_attribute("antnest.outcome", outcome);
        span.set_attribute("antnest.operation.phase", "control_http");
        span.set_attribute("antnest.response.termination", termination);
        span.set_attribute("error.type", code);
        span.set_attribute("http.request.body.size", observed_count(request.observed));
        if status.is_some() {
            span.set_attribute("http.response.body.size", observed_count(self.observed));
        }
        let elapsed = self.started.elapsed();
        span.set_attribute(
            "http.server.request.duration_ms",
            elapsed.as_secs_f64() * 1000.0,
        );
        if failed {
            span.set_status(Status::error(code));
        }
        let (stage, cause, message) = self.failure.as_ref().map_or(
            ("control_http", code, safe_transport_message(code)),
            |failure| {
                failure.diagnostic.as_ref().map_or(
                    ("control_dispatch", failure.code, failure.message),
                    |context| (context.stage, context.cause, failure.message),
                )
            },
        );
        if !code.is_empty() || failed {
            span.set_attribute("antnest.error.code", code);
            span.set_attribute("antnest.error.type", code);
            span.set_attribute("antnest.error.stage", stage);
            span.set_attribute("antnest.error.origin", stage);
            span.set_attribute("failure.stage", stage);
            span.set_attribute("failure.cause", cause);
            span.add_event(
                "antnest.error",
                vec![
                    KeyValue::new("error.type", code),
                    KeyValue::new("antnest.error.code", code),
                    KeyValue::new("antnest.error.type", code),
                    KeyValue::new("antnest.error.stage", stage),
                    KeyValue::new("antnest.operation.phase", stage),
                    KeyValue::new(
                        "antnest.error.cause_types",
                        Value::Array(Array::String(vec![cause.into()])),
                    ),
                    KeyValue::new(
                        "antnest.error.causes",
                        serde_json::json!([{"type": cause, "message": safe_cause_message(cause)}])
                            .to_string(),
                    ),
                    KeyValue::new("antnest.error.message", message),
                ],
            );
        }
        span.add_event(
            "antnest.complete",
            vec![
                KeyValue::new("antnest.outcome", outcome),
                KeyValue::new("antnest.response.termination", termination),
            ],
        );
        if let Some(status) = status {
            self.metrics.control(
                &self.method,
                &self.route,
                status.as_u16(),
                outcome,
                code,
                elapsed,
            );
        }
        if self.route != "/status" || outcome != "success" {
            let context = span.context();
            let active = context.span();
            tracing::info!(target: "antnest_runtime_egress::control::completion",
                trace_id = %active.span_context().trace_id(), span_id = %active.span_context().span_id(),
                http.request.method = self.method, http.route = self.route,
                http.response.status_code = status.map(|status| status.as_u16()),
                antnest.outcome = outcome, error.type = code, failure.stage = stage,
                failure.cause = cause, failure.message = message,
                "Runtime Egress control request completed");
        }
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        self.finish(if std::thread::panicking() {
            "panic"
        } else {
            "cancelled"
        });
    }
}

struct ResponseBody {
    inner: Body,
    completion: Completion,
}

impl http_body::Body for ResponseBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.inner).poll_frame(cx);
        match &result {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref() {
                    self.completion.observed =
                        self.completion.observed.saturating_add(bytes.len() as u64);
                }
                if self.inner.is_end_stream() {
                    self.completion.finish("eof");
                }
            }
            Poll::Ready(None) => self.completion.finish("eof"),
            Poll::Ready(Some(Err(_))) => self.completion.finish("body_error"),
            Poll::Pending => {}
        }
        result
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn observed_count(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn safe_cause_message(cause: &str) -> &'static str {
    match cause {
        "kernel_command_failed" => "Kernel cleanup did not complete; affected Agent remains fenced",
        "repository_connection_unavailable" => {
            "An own-database connection could not be acquired or maintained"
        }
        "repository_operation_timeout" => "Own-database operation exceeded its configured deadline",
        "repository_operation_failed" => {
            "Own-database operation failed; driver details belong to the database span"
        }
        "repository_unavailable" => "Own-database schema or initialization is unavailable",
        "repository_invalid_pool" => "Configured tunnel address pool is invalid",
        _ => "Control boundary returned the recorded rejection or transport failure",
    }
}

fn safe_transport_message(code: &str) -> &'static str {
    match code {
        "request_body_error" => "control request body could not be read",
        "response_body_error" => "control response body could not be delivered",
        "handler_panic" => "control handler unwound before completion; panic content omitted",
        "http_request_rejected" => "HTTP adapter rejected the request",
        "http_server_error" => "HTTP adapter could not complete the request",
        _ => "control operation completed",
    }
}

#[cfg(test)]
#[path = "observation_tests.rs"]
mod tests;
