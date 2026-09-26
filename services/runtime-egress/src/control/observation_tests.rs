use std::{
    collections::VecDeque,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, StatusCode},
};
use http_body::{Frame, SizeHint};
use http_body_util::BodyExt as _;
use opentelemetry::trace::{Status, TracerProvider as _};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use tracing::instrument::WithSubscriber as _;
use tracing_subscriber::layer::SubscriberExt as _;

use super::*;

struct Frames {
    polls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
    frames: VecDeque<Result<Frame<Bytes>, std::io::Error>>,
}

impl http_body::Body for Frames {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(self.frames.pop_front())
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

fn completion() -> Completion {
    Completion::new(
        tracing::info_span!("test.control", otel.kind = "server"),
        "POST".to_owned(),
        "/test".to_owned(),
        EgressMetrics::default(),
        CaptureHandle::new(),
    )
}

#[tokio::test]
async fn rpc_capture_is_scoped_complete_and_does_not_serialize_when_disabled() {
    struct Probe(Arc<AtomicUsize>);
    impl serde::Serialize for Probe {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            self.0.fetch_add(1, Ordering::SeqCst);
            serializer.serialize_str("probe")
        }
    }
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("rpc-capture")));
    let calls = Arc::new(AtomicUsize::new(0));
    let value = serde_json::json!({"new_field": {"unregistered": "x".repeat(24 * 1024)}});
    async {
        let span = tracing::info_span!("rpc");
        let _entered = span.enter();
        rpc_content("antnest.request", &Probe(calls.clone()));
        rpc_scope(false, async {
            rpc_content("antnest.response", &Probe(calls.clone()));
        })
        .await;
        rpc_scope(true, async {
            rpc_content("antnest.request", &value);
            rpc_scope(false, async {
                rpc_content("antnest.response", &Probe(calls.clone()));
            })
            .await;
            rpc_content("antnest.response", &value);
        })
        .await;
        rpc_content("antnest.response", &Probe(calls.clone()));
    }
    .with_subscriber(subscriber)
    .await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].events.len(), 2);
    for event in &spans[0].events.events {
        let encoded = event
            .attributes
            .iter()
            .find(|attribute| attribute.key.as_str() == "antnest.payload.json")
            .unwrap()
            .value
            .to_string();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
            value
        );
    }
}

#[tokio::test]
async fn degraded_readiness_is_visible_without_changing_http_success() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("readiness-test")));
    async {
        let status = crate::application::ServiceStatus {
            status: "degraded",
            data_plane_ready: false,
            control_plane_ready: true,
            snapshot_revision: 3,
        };
        let response = completion().respond(crate::control::status_response(status));
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["status"], "degraded");
    }
    .with_subscriber(subscriber)
    .await;
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert!(matches!(spans[0].status, Status::Error { .. }));
    assert!(
        spans[0]
            .attributes
            .iter()
            .any(|attribute| attribute.key.as_str() == "error.type"
                && attribute.value.as_str() == "service_not_ready")
    );
}

#[tokio::test]
async fn response_lifetime_preserves_frames_errors_trailers_and_drop() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::Registry::default()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("body-test")));
    async {
        let polls = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        let mut trailers = HeaderMap::new();
        trailers.insert("x-secret", HeaderValue::from_static("TRAILER_CANARY"));
        let frames = Frames {
            polls: polls.clone(),
            drops: drops.clone(),
            frames: VecDeque::from([
                Ok(Frame::data(Bytes::from_static(b"first"))),
                Ok(Frame::trailers(trailers.clone())),
            ]),
        };
        let mut response = completion().respond(Response::new(Body::new(frames)));
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        assert!(exporter.get_finished_spans().unwrap().is_empty());
        assert_eq!(
            response
                .body_mut()
                .frame()
                .await
                .unwrap()
                .unwrap()
                .into_data()
                .unwrap(),
            "first"
        );
        assert!(exporter.get_finished_spans().unwrap().is_empty());
        assert_eq!(
            response
                .body_mut()
                .frame()
                .await
                .unwrap()
                .unwrap()
                .into_trailers()
                .unwrap(),
            trailers
        );
        assert!(response.body_mut().frame().await.is_none());
        drop(response);
        assert_eq!(drops.load(Ordering::SeqCst), 1);

        let response = completion().respond(Response::new(Body::from("never read")));
        drop(response);

        let frames = Frames {
            polls,
            drops,
            frames: VecDeque::from([
                Ok(Frame::data(Bytes::from(vec![b'x'; 1024 * 1024]))),
                Err(std::io::Error::other("BODY_ERROR_CANARY")),
            ]),
        };
        let response = completion().respond(Response::new(Body::new(frames)));
        assert!(response.into_body().collect().await.is_err());

        let response = super::super::ApiError::new(
            StatusCode::OK,
            "operation_failed",
            "control operation did not complete",
            true,
        )
        .into_response();
        completion()
            .respond(response)
            .into_body()
            .collect()
            .await
            .unwrap();

        drop(completion()); // Handler future cancelled before a response exists.

        let source = crate::application::FailureContext::new(
            "assign_policy.kernel_cleanup",
            "kernel_command_failed",
        )
        .with_kernel_source("KERNEL_SOURCE_CANARY".to_owned());
        let error = crate::application::ControlError::CleanupFailed(source);
        assert!(std::error::Error::source(&error).is_some());
        let response = super::super::ApiError::from(error).into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        completion()
            .respond(response)
            .into_body()
            .collect()
            .await
            .unwrap();
    }
    .with_subscriber(subscriber)
    .await;
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 6);
    let attr = |index: usize, key: &str| {
        spans[index]
            .attributes
            .iter()
            .find(|item| item.key.as_str() == key)
            .map(|item| item.value.to_string())
    };
    assert_eq!(attr(0, "http.response.body.size").as_deref(), Some("5"));
    assert_eq!(attr(0, "antnest.outcome").as_deref(), Some("success"));
    assert_eq!(attr(1, "antnest.outcome").as_deref(), Some("cancelled"));
    assert_eq!(
        attr(2, "error.type").as_deref(),
        Some("response_body_error")
    );
    assert_eq!(
        attr(2, "http.response.body.size").as_deref(),
        Some("1048576")
    );
    assert_eq!(attr(3, "http.response.status_code").as_deref(), Some("200"));
    assert_eq!(attr(3, "antnest.outcome").as_deref(), Some("error"));
    assert!(matches!(spans[3].status, Status::Error { .. }));
    assert!(attr(4, "http.response.status_code").is_none());
    assert_eq!(attr(4, "antnest.outcome").as_deref(), Some("cancelled"));
    assert_eq!(attr(5, "http.response.status_code").as_deref(), Some("503"));
    assert_eq!(
        attr(5, "failure.stage").as_deref(),
        Some("assign_policy.kernel_cleanup")
    );
    assert_eq!(
        attr(5, "failure.cause").as_deref(),
        Some("kernel_command_failed")
    );
    assert!(!format!("{spans:?}").contains("CANARY"));
    provider.shutdown().unwrap();
}

#[tokio::test]
async fn request_observation_is_lazy_and_never_caches_raw_bytes() {
    let capture = CaptureHandle::new();
    let polls = Arc::new(AtomicUsize::new(0));
    let drops = Arc::new(AtomicUsize::new(0));
    let body = Body::new(Frames {
        polls: polls.clone(),
        drops: drops.clone(),
        frames: VecDeque::from([Ok(Frame::data(Bytes::from(vec![b'x'; 1024 * 1024])))]),
    });
    let body = RequestBody {
        inner: body,
        capture: capture.clone(),
    };
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    body.collect().await.unwrap();
    assert_eq!(capture.snapshot().observed, 1024 * 1024);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}
