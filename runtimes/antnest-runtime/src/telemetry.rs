use std::net::IpAddr;
use std::time::Duration;

use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::{TraceContextExt as _, TracerProvider as _};
use opentelemetry::{KeyValue, global};
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{Layer as _, Registry};

use crate::network::PlatformNetwork;
use crate::spec::RuntimeIdentity;

pub(crate) const SERVICE_NAME: &str = "antnest-runtime";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub(crate) enum TelemetryError {
    #[error("install tracing subscriber: {0}")]
    Subscriber(String),
}

pub(crate) struct Telemetry {
    tracer_provider: Option<SdkTracerProvider>,
    otlp_enabled: bool,
    identity: RuntimeIdentity,
}

#[derive(Clone, Debug)]
pub(crate) struct TelemetryConfig {
    log_filter: String,
    export: ExportDecision,
    endpoint: String,
}

pub(crate) struct TelemetryEnvironment {
    pub(crate) log_filter: Option<String>,
    pub(crate) sdk_disabled: Option<String>,
    pub(crate) exporter: Option<String>,
    pub(crate) traces_endpoint: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) traces_protocol: Option<String>,
    pub(crate) protocol: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ExportDecision {
    Disabled,
    Otlp,
    Unsupported(TelemetryWarning),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TelemetryWarning {
    error_type: &'static str,
    reason: String,
}

impl TelemetryWarning {
    fn new(error_type: &'static str, reason: impl Into<String>) -> Self {
        Self {
            error_type,
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TraceContext {
    traceparent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tracestate: Option<String>,
}

impl Telemetry {
    pub(crate) fn init(
        identity: &RuntimeIdentity,
        platform: &PlatformNetwork,
        config: &TelemetryConfig,
    ) -> Result<Self, TelemetryError> {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let mut warnings = Vec::new();
        let filter = EnvFilter::try_new(&config.log_filter).unwrap_or_else(|error| {
            warnings.push(TelemetryWarning::new(
                "invalid_log_filter",
                format!("RUST_LOG was rejected: {error}"),
            ));
            EnvFilter::new("info,hyper=warn,reqwest=warn")
        });
        let console = tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_target(true)
            .with_current_span(true)
            .with_span_list(false)
            .flatten_event(true)
            .with_filter(filter.clone())
            .boxed();
        let mut layers: Vec<Box<dyn tracing_subscriber::Layer<Registry> + Send + Sync>> =
            vec![console];
        let exported_provider = match &config.export {
            ExportDecision::Disabled => None,
            ExportDecision::Unsupported(warning) => {
                warnings.push(warning.clone());
                None
            }
            ExportDecision::Otlp => match validate_otlp_destination(&config.endpoint, platform) {
                Err(reason) => {
                    warnings.push(TelemetryWarning::new("invalid_otlp_destination", reason));
                    None
                }
                Ok(endpoint) => match build_otlp_provider(identity, &endpoint) {
                    Err(error) => {
                        warnings.push(TelemetryWarning::new(
                            "otlp_exporter_initialization_failed",
                            error.to_string(),
                        ));
                        None
                    }
                    Ok(provider) => Some(provider),
                },
            },
        };
        let otlp_enabled = exported_provider.is_some();
        let tracer_provider = exported_provider.unwrap_or_else(|| build_local_provider(identity));
        let tracer = tracer_provider.tracer(SERVICE_NAME);
        layers.push(
            tracing_opentelemetry::layer()
                .with_tracer(tracer)
                .with_filter(tracing_subscriber::filter::filter_fn(is_runtime_trace))
                .boxed(),
        );
        global::set_tracer_provider(tracer_provider.clone());
        Registry::default()
            .with(layers)
            .try_init()
            .map_err(|error| TelemetryError::Subscriber(error.to_string()))?;
        for warning in warnings {
            tracing::warn!(
                error.type = warning.error_type,
                reason = %warning.reason,
                "service.name" = SERVICE_NAME,
                "antnest.agent.id" = identity.agent_id(),
                "antnest.runtime.generation" = %identity.generation(),
                trace_id = "",
                span_id = "",
                "telemetry configuration was not applied"
            );
        }
        tracing::info!(
            otlp_enabled,
            "service.name" = SERVICE_NAME,
            "service.version" = env!("CARGO_PKG_VERSION"),
            "antnest.agent.id" = identity.agent_id(),
            "antnest.runtime.generation" = %identity.generation(),
            trace_id = "",
            span_id = "",
            "Runtime telemetry initialized"
        );
        Ok(Self {
            tracer_provider: Some(tracer_provider),
            otlp_enabled,
            identity: identity.clone(),
        })
    }

    pub(crate) fn shutdown(mut self) {
        let provider = self
            .tracer_provider
            .take()
            .expect("Telemetry always owns one local tracer provider");
        if let Err(error) = provider.shutdown_with_timeout(SHUTDOWN_TIMEOUT) {
            let error_type = if self.otlp_enabled {
                "otlp_shutdown_failed"
            } else {
                "telemetry_shutdown_failed"
            };
            tracing::error!(
                "service.name" = SERVICE_NAME,
                "antnest.agent.id" = self.identity.agent_id(),
                "antnest.runtime.generation" = %self.identity.generation(),
                error.type = error_type,
                reason = %error,
                trace_id = "",
                span_id = "",
                "Runtime telemetry stopped"
            );
        } else {
            tracing::info!(
                "service.name" = SERVICE_NAME,
                "antnest.agent.id" = self.identity.agent_id(),
                "antnest.runtime.generation" = %self.identity.generation(),
                otlp_enabled = self.otlp_enabled,
                trace_id = "",
                span_id = "",
                "Runtime telemetry stopped"
            );
        }
    }
}

impl TelemetryConfig {
    pub(crate) fn resolve(environment: TelemetryEnvironment) -> Self {
        let export = resolve_export(
            environment.sdk_disabled.as_deref(),
            environment.exporter.as_deref(),
            environment.traces_endpoint.as_deref(),
            environment.endpoint.as_deref(),
        );
        let export = if export == ExportDecision::Otlp {
            resolve_protocol(
                environment.traces_protocol.as_deref(),
                environment.protocol.as_deref(),
            )
            .map_or_else(ExportDecision::Unsupported, |()| ExportDecision::Otlp)
        } else {
            export
        };
        Self {
            log_filter: environment
                .log_filter
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "info,hyper=warn,reqwest=warn".into()),
            export,
            endpoint: environment
                .traces_endpoint
                .or(environment.endpoint)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:4318".into()),
        }
    }
}

fn validate_otlp_destination(endpoint: &str, platform: &PlatformNetwork) -> Result<String, String> {
    let endpoint =
        url::Url::parse(endpoint).map_err(|error| format!("parse OTLP endpoint: {error}"))?;
    if endpoint.scheme() != "http" {
        return Err("OTLP endpoint must use http".into());
    }
    let address = match endpoint.host() {
        Some(url::Host::Ipv4(address)) => IpAddr::V4(address),
        Some(url::Host::Ipv6(_)) => {
            return Err("OTLP endpoint must use a literal IPv4 address".into());
        }
        Some(url::Host::Domain(_)) => {
            return Err("OTLP endpoint must use a literal IPv4 address".into());
        }
        None => return Err("OTLP endpoint has no host".into()),
    };
    if endpoint.port_or_known_default().is_none() {
        return Err("OTLP endpoint has no port".into());
    }
    if !platform.contains(address) {
        return Err(format!(
            "OTLP endpoint {address} is outside the direct platform network"
        ));
    }
    Ok(endpoint.to_string())
}

fn build_otlp_provider(
    identity: &RuntimeIdentity,
    endpoint: &str,
) -> Result<SdkTracerProvider, Box<dyn std::error::Error + Send + Sync>> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .build()?;
    Ok(SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(runtime_resource(identity))
        .build())
}

fn build_local_provider(identity: &RuntimeIdentity) -> SdkTracerProvider {
    SdkTracerProvider::builder()
        .with_resource(runtime_resource(identity))
        .build()
}

fn runtime_resource(identity: &RuntimeIdentity) -> Resource {
    Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attributes([
            KeyValue::new("service.namespace", "antnest"),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
            KeyValue::new("antnest.agent.id", identity.agent_id().to_owned()),
            KeyValue::new(
                "antnest.runtime.generation",
                identity.generation().to_string(),
            ),
        ])
        .build()
}

fn resolve_export(
    sdk_disabled: Option<&str>,
    exporter: Option<&str>,
    traces_endpoint: Option<&str>,
    endpoint: Option<&str>,
) -> ExportDecision {
    if sdk_disabled.is_some_and(|value| value.trim().eq_ignore_ascii_case("true")) {
        return ExportDecision::Disabled;
    }
    if let Some(exporter) = exporter.map(str::trim).filter(|value| !value.is_empty()) {
        return match exporter.to_ascii_lowercase().as_str() {
            "none" => ExportDecision::Disabled,
            "otlp" => ExportDecision::Otlp,
            _ => ExportDecision::Unsupported(TelemetryWarning::new(
                "unsupported_trace_exporter",
                format!("OTEL_TRACES_EXPORTER={exporter}"),
            )),
        };
    }
    if [traces_endpoint, endpoint]
        .into_iter()
        .flatten()
        .any(|value| !value.trim().is_empty())
    {
        ExportDecision::Otlp
    } else {
        ExportDecision::Disabled
    }
}

fn resolve_protocol(
    traces_protocol: Option<&str>,
    protocol: Option<&str>,
) -> Result<(), TelemetryWarning> {
    let (name, value) = if let Some(value) = traces_protocol
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        ("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", value)
    } else if let Some(value) = protocol.map(str::trim).filter(|value| !value.is_empty()) {
        ("OTEL_EXPORTER_OTLP_PROTOCOL", value)
    } else {
        return Ok(());
    };
    if value.eq_ignore_ascii_case("http/protobuf") {
        Ok(())
    } else {
        Err(TelemetryWarning::new(
            "unsupported_otlp_protocol",
            format!("{name}={value}"),
        ))
    }
}

impl Injector for TraceContext {
    fn set(&mut self, key: &str, value: String) {
        match key {
            "traceparent" => self.traceparent = value,
            "tracestate" => self.tracestate = Some(value),
            _ => {}
        }
    }
}

impl Extractor for TraceContext {
    fn get(&self, key: &str) -> Option<&str> {
        match key {
            "traceparent" => Some(self.traceparent.as_str()).filter(|value| !value.is_empty()),
            "tracestate" => self.tracestate.as_deref(),
            _ => None,
        }
    }

    fn keys(&self) -> Vec<&str> {
        let mut keys = vec!["traceparent"];
        if self.tracestate.is_some() {
            keys.push("tracestate");
        }
        keys
    }
}

impl TraceContext {
    pub(crate) fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let traceparent = headers.get("traceparent")?.to_str().ok()?.to_owned();
        let tracestate = headers
            .get("tracestate")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        Some(Self {
            traceparent,
            tracestate,
        })
    }
}

pub(crate) fn set_remote_parent(span: &tracing::Span, carrier: Option<&TraceContext>) {
    let Some(carrier) = carrier else {
        return;
    };
    let context = global::get_text_map_propagator(|propagator| propagator.extract(carrier));
    let _ = span.set_parent(context);
}

pub(crate) fn record_span_identity(span: &tracing::Span) {
    let (trace_id, span_id) = span_identity(span);
    if trace_id.is_empty() {
        return;
    }
    span.record("trace_id", trace_id.as_str());
    span.record("span_id", span_id.as_str());
}

pub(crate) fn span_identity(span: &tracing::Span) -> (String, String) {
    let context = span.context();
    let current = context.span();
    let span_context = current.span_context();
    if !span_context.is_valid() {
        return (String::new(), String::new());
    }
    (
        span_context.trace_id().to_string(),
        span_context.span_id().to_string(),
    )
}

fn is_runtime_trace(metadata: &tracing::Metadata<'_>) -> bool {
    metadata.target().starts_with("antnest_runtime")
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use opentelemetry::global;
    use opentelemetry::trace::{TraceContextExt as _, TracerProvider as _};
    use opentelemetry_sdk::propagation::TraceContextPropagator;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tracing_opentelemetry::OpenTelemetrySpanExt as _;
    use tracing_subscriber::layer::{Layer as _, SubscriberExt as _};

    use crate::network::{PlatformNetwork, PlatformRoute};
    use crate::spec::RuntimeIdentity;

    use super::{
        ExportDecision, SERVICE_NAME, TelemetryConfig, TelemetryEnvironment, TelemetryWarning,
        TraceContext, build_local_provider, resolve_export, resolve_protocol, set_remote_parent,
        validate_otlp_destination,
    };

    #[test]
    fn stderr_log_filter_cannot_disable_runtime_trace_spans() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let tracer = provider.tracer(SERVICE_NAME);
        let console = tracing_subscriber::fmt::layer()
            .with_writer(std::io::sink)
            .with_filter(tracing_subscriber::EnvFilter::new("warn"));
        let traces = tracing_opentelemetry::layer()
            .with_tracer(tracer)
            .with_filter(tracing_subscriber::filter::filter_fn(
                super::is_runtime_trace,
            ));
        let subscriber = tracing_subscriber::Registry::default()
            .with(console)
            .with(traces);

        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("runtime.test");
            let _entered = span.enter();
        });
        provider.force_flush().unwrap();

        assert!(
            exporter
                .get_finished_spans()
                .unwrap()
                .iter()
                .any(|span| span.name == "runtime.test")
        );
        let _ = provider.shutdown();
    }

    #[test]
    fn local_tracer_preserves_remote_parent_without_an_exporter() {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let identity = RuntimeIdentity::new("agent-telemetry", 3).unwrap();
        let provider = build_local_provider(&identity);
        let tracer = provider.tracer(SERVICE_NAME);
        let subscriber = tracing_subscriber::Registry::default()
            .with(tracing_opentelemetry::layer().with_tracer(tracer));
        let parent_trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
        let carrier = TraceContext {
            traceparent: format!("00-{parent_trace_id}-00f067aa0ba902b7-01"),
            tracestate: None,
        };

        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("local-trace-test");
            set_remote_parent(&span, Some(&carrier));
            let context = span.context();
            let current = context.span();
            assert!(current.span_context().is_valid());
            assert_eq!(
                current.span_context().trace_id().to_string(),
                parent_trace_id
            );
        });

        let _ = provider.shutdown();
    }

    #[test]
    fn otlp_collector_must_use_a_platform_route() {
        let platform = PlatformNetwork::new(vec![
            PlatformRoute::new("eth0".into(), Ipv4Addr::new(172, 30, 0, 0), 16).unwrap(),
        ]);

        assert!(validate_otlp_destination("http://127.0.0.1:4318", &platform).is_ok());
        assert!(validate_otlp_destination("http://172.30.0.10:4318", &platform).is_ok());
        assert!(validate_otlp_destination("http://1.1.1.1:4318", &platform).is_err());
        assert!(validate_otlp_destination("http://collector:4318", &platform).is_err());
    }

    #[test]
    fn trace_export_is_opt_in_and_honors_standard_disable_controls() {
        assert_eq!(
            resolve_export(None, None, None, None),
            ExportDecision::Disabled
        );
        assert_eq!(
            resolve_export(
                Some("true"),
                Some("otlp"),
                None,
                Some("http://collector:4318")
            ),
            ExportDecision::Disabled
        );
        assert_eq!(
            resolve_export(None, Some("none"), None, Some("http://collector:4318")),
            ExportDecision::Disabled
        );
        assert_eq!(
            resolve_export(None, None, Some("http://collector:4318/v1/traces"), None),
            ExportDecision::Otlp
        );
        assert_eq!(
            resolve_export(None, Some("otlp"), None, None),
            ExportDecision::Otlp
        );
    }

    #[test]
    fn unsupported_exporters_do_not_silently_enable_otlp() {
        assert_eq!(
            resolve_export(None, Some("console"), None, Some("http://collector:4318")),
            ExportDecision::Unsupported(TelemetryWarning::new(
                "unsupported_trace_exporter",
                "OTEL_TRACES_EXPORTER=console"
            ))
        );
    }

    #[test]
    fn only_http_protobuf_is_accepted_for_otlp_export() {
        assert_eq!(resolve_protocol(None, None), Ok(()));
        assert_eq!(resolve_protocol(Some("http/protobuf"), None), Ok(()));
        assert_eq!(resolve_protocol(None, Some("http/protobuf")), Ok(()));
        assert_eq!(
            resolve_protocol(Some("grpc"), Some("http/protobuf")),
            Err(TelemetryWarning::new(
                "unsupported_otlp_protocol",
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc"
            ))
        );
        assert_eq!(
            resolve_protocol(None, Some("http/json")),
            Err(TelemetryWarning::new(
                "unsupported_otlp_protocol",
                "OTEL_EXPORTER_OTLP_PROTOCOL=http/json"
            ))
        );
    }

    #[test]
    fn trace_specific_configuration_wins_without_late_environment_reads() {
        let config = TelemetryConfig::resolve(TelemetryEnvironment {
            log_filter: Some("debug".into()),
            sdk_disabled: None,
            exporter: Some("otlp".into()),
            traces_endpoint: Some("http://127.0.0.1:9000".into()),
            endpoint: Some("http://127.0.0.1:4318".into()),
            traces_protocol: Some("http/protobuf".into()),
            protocol: Some("grpc".into()),
        });
        assert_eq!(config.log_filter, "debug");
        assert_eq!(config.export, ExportDecision::Otlp);
        assert_eq!(config.endpoint, "http://127.0.0.1:9000");
    }

    #[test]
    fn wire_trace_context_is_strict_and_content_free() {
        let context: TraceContext = serde_json::from_value(serde_json::json!({
            "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "tracestate": "vendor=value"
        }))
        .expect("trace context");
        assert!(context.traceparent.starts_with("00-"));
        assert!(
            serde_json::from_value::<TraceContext>(serde_json::json!({
                "traceparent": "valid-shape-is-validated-by-propagator",
                "command": "secret"
            }))
            .is_err()
        );
    }
}
