use std::net::IpAddr;
use std::time::{Duration, Instant};

use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::{TraceContextExt as _, TracerProvider as _};
use opentelemetry::{
    KeyValue, global,
    metrics::{Counter, Histogram, Meter, MeterProvider as _},
};
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::filter::{EnvFilter, FilterExt as _, filter_fn};
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
    meter_provider: Option<SdkMeterProvider>,
    trace_otlp_enabled: bool,
    metrics_otlp_enabled: bool,
    metrics: RuntimeMetrics,
    identity: RuntimeIdentity,
}

#[derive(Clone, Debug)]
pub(crate) struct TelemetryConfig {
    image_reference: String,
    image_id: String,
    capture_rpc_content: bool,
    log_filter: String,
    export: ExportDecision,
    endpoint: String,
    metrics_export: ExportDecision,
    metrics_endpoint: String,
}

#[derive(Default)]
pub(crate) struct TelemetryEnvironment {
    pub(crate) image_reference: Option<String>,
    pub(crate) image_id: Option<String>,
    pub(crate) capture_rpc_content: Option<String>,
    pub(crate) log_filter: Option<String>,
    pub(crate) sdk_disabled: Option<String>,
    pub(crate) exporter: Option<String>,
    pub(crate) traces_endpoint: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) traces_protocol: Option<String>,
    pub(crate) protocol: Option<String>,
    pub(crate) metrics_exporter: Option<String>,
    pub(crate) metrics_endpoint: Option<String>,
    pub(crate) metrics_protocol: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeMetrics {
    pub(crate) capture_rpc_content: bool,
    http_requests: Counter<u64>,
    http_duration_ms: Histogram<f64>,
    mcp_operations: Counter<u64>,
    mcp_duration_ms: Histogram<f64>,
    tool_calls: Counter<u64>,
    tool_duration_ms: Histogram<f64>,
    executor_calls: Counter<u64>,
    executor_duration_ms: Histogram<f64>,
    network_outbound_packets: Counter<u64>,
    network_outbound_bytes: Counter<u64>,
    network_inbound_packets: Counter<u64>,
    network_inbound_bytes: Counter<u64>,
    network_unsupported_packets: Counter<u64>,
    network_local_rejections: Counter<u64>,
    network_malformed_packets: Counter<u64>,
    network_connection_refused: Counter<u64>,
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

impl RuntimeMetrics {
    fn new(meter: Meter) -> Self {
        Self {
            capture_rpc_content: false,
            http_requests: meter
                .u64_counter("antnest.runtime.http.requests")
                .with_description("Completed Runtime HTTP requests")
                .build(),
            http_duration_ms: meter
                .f64_histogram("antnest.runtime.http.duration")
                .with_description("Runtime HTTP response-body completion latency")
                .with_unit("ms")
                .build(),
            mcp_operations: meter
                .u64_counter("antnest.runtime.mcp.operations")
                .with_description("Completed MCP protocol operations")
                .build(),
            mcp_duration_ms: meter
                .f64_histogram("antnest.runtime.mcp.duration")
                .with_description("MCP protocol operation latency")
                .with_unit("ms")
                .build(),
            tool_calls: meter
                .u64_counter("antnest.runtime.tool.calls")
                .with_description("Completed Runtime tool calls")
                .build(),
            tool_duration_ms: meter
                .f64_histogram("antnest.runtime.tool.duration")
                .with_description("Runtime tool call latency")
                .with_unit("ms")
                .build(),
            executor_calls: meter
                .u64_counter("antnest.runtime.executor.calls")
                .with_description("Completed non-privileged Executor calls")
                .build(),
            executor_duration_ms: meter
                .f64_histogram("antnest.runtime.executor.duration")
                .with_description("Non-privileged Executor latency")
                .with_unit("ms")
                .build(),
            network_outbound_packets: meter
                .u64_counter("antnest.runtime.network.outbound.packets")
                .build(),
            network_outbound_bytes: meter
                .u64_counter("antnest.runtime.network.outbound.bytes")
                .with_unit("By")
                .build(),
            network_inbound_packets: meter
                .u64_counter("antnest.runtime.network.inbound.packets")
                .build(),
            network_inbound_bytes: meter
                .u64_counter("antnest.runtime.network.inbound.bytes")
                .with_unit("By")
                .build(),
            network_unsupported_packets: meter
                .u64_counter("antnest.runtime.network.unsupported.packets")
                .build(),
            network_local_rejections: meter
                .u64_counter("antnest.runtime.network.local_rejections")
                .build(),
            network_malformed_packets: meter
                .u64_counter("antnest.runtime.network.malformed.packets")
                .build(),
            network_connection_refused: meter
                .u64_counter("antnest.runtime.network.connection_refused")
                .build(),
        }
    }

    pub(crate) fn with_rpc_content(mut self, capture_rpc_content: bool) -> Self {
        self.capture_rpc_content = capture_rpc_content;
        self
    }

    pub(crate) fn http(
        &self,
        method: &str,
        route: &'static str,
        outcome: &'static str,
        error_type: &'static str,
        duration: Duration,
    ) {
        let mut attributes = vec![
            KeyValue::new("http.request.method", method.to_owned()),
            KeyValue::new("http.route", route),
            KeyValue::new("outcome", outcome),
        ];
        if !error_type.is_empty() {
            attributes.push(KeyValue::new("error.type", error_type));
        }
        self.http_requests.add(1, &attributes);
        self.http_duration_ms
            .record(duration.as_secs_f64() * 1000.0, &attributes);
    }

    pub(crate) fn mcp(
        &self,
        operation: &'static str,
        outcome: &'static str,
        error_type: &'static str,
        duration: Duration,
    ) {
        let attributes = operation_attributes("mcp.operation", operation, outcome, error_type);
        self.mcp_operations.add(1, &attributes);
        self.mcp_duration_ms
            .record(duration.as_secs_f64() * 1000.0, &attributes);
    }

    pub(crate) fn tool(
        &self,
        tool: &'static str,
        outcome: &'static str,
        error_type: &'static str,
        duration: Duration,
    ) {
        let attributes = operation_attributes("tool", tool, outcome, error_type);
        self.tool_calls.add(1, &attributes);
        self.tool_duration_ms
            .record(duration.as_secs_f64() * 1000.0, &attributes);
    }

    pub(crate) fn executor(
        &self,
        tool: &'static str,
        outcome: &'static str,
        error_type: &'static str,
        duration: Duration,
    ) {
        let attributes = operation_attributes("tool", tool, outcome, error_type);
        self.executor_calls.add(1, &attributes);
        self.executor_duration_ms
            .record(duration.as_secs_f64() * 1000.0, &attributes);
    }

    pub(crate) fn network_outbound(&self, bytes: usize) {
        self.network_outbound_packets.add(1, &[]);
        self.network_outbound_bytes
            .add(u64::try_from(bytes).unwrap_or(u64::MAX), &[]);
    }

    pub(crate) fn network_inbound(&self, bytes: usize) {
        self.network_inbound_packets.add(1, &[]);
        self.network_inbound_bytes
            .add(u64::try_from(bytes).unwrap_or(u64::MAX), &[]);
    }

    pub(crate) fn network_unsupported(&self, rejected_locally: bool) {
        self.network_unsupported_packets.add(1, &[]);
        if rejected_locally {
            self.network_local_rejections.add(1, &[]);
        }
    }

    pub(crate) fn network_malformed(&self) {
        self.network_malformed_packets.add(1, &[]);
    }

    pub(crate) fn network_connection_refused(&self) {
        self.network_connection_refused.add(1, &[]);
    }
}

impl Default for RuntimeMetrics {
    fn default() -> Self {
        let provider = opentelemetry::metrics::NoopMeterProvider::new();
        Self::new(provider.meter(SERVICE_NAME))
    }
}

fn operation_attributes(
    name: &'static str,
    operation: &'static str,
    outcome: &'static str,
    error_type: &'static str,
) -> Vec<KeyValue> {
    let mut attributes = vec![
        KeyValue::new(name, operation),
        KeyValue::new("outcome", outcome),
    ];
    if !error_type.is_empty() {
        attributes.push(KeyValue::new("error.type", error_type));
    }
    attributes
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
            .with_filter(filter_fn(is_runtime_log).and(filter.clone()))
            .boxed();
        let mut layers: Vec<Box<dyn tracing_subscriber::Layer<Registry> + Send + Sync>> =
            vec![console];
        let (tracer_provider, trace_otlp_enabled) =
            configured_tracer(identity, platform, config, &mut warnings);
        let (meter_provider, metrics_otlp_enabled) =
            configured_meter(platform, config, &mut warnings);
        let metrics = RuntimeMetrics::new(meter_provider.meter(SERVICE_NAME))
            .with_rpc_content(config.capture_rpc_content);
        let tracer = tracer_provider.tracer(SERVICE_NAME);
        layers.push(
            tracing_opentelemetry::layer()
                .with_tracer(tracer)
                .with_filter(tracing_subscriber::filter::filter_fn(is_runtime_trace))
                .boxed(),
        );
        global::set_tracer_provider(tracer_provider.clone());
        global::set_meter_provider(meter_provider.clone());
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
            trace_otlp_enabled,
            metrics_otlp_enabled,
            "antnest.runtime.image.reference" = %config.image_reference,
            "antnest.runtime.image.id" = %config.image_id,
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
            meter_provider: Some(meter_provider),
            trace_otlp_enabled,
            metrics_otlp_enabled,
            metrics,
            identity: identity.clone(),
        })
    }

    pub(crate) fn metrics(&self) -> RuntimeMetrics {
        self.metrics.clone()
    }

    pub(crate) fn shutdown(mut self) {
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        let meter_provider = self
            .meter_provider
            .take()
            .expect("Telemetry always owns one local meter provider");
        if let Err(error) =
            meter_provider.shutdown_with_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            tracing::error!(
                "service.name" = SERVICE_NAME,
                "antnest.agent.id" = self.identity.agent_id(),
                "antnest.runtime.generation" = %self.identity.generation(),
                error.type = if self.metrics_otlp_enabled {
                    "otlp_metrics_shutdown_failed"
                } else {
                    "metrics_shutdown_failed"
                },
                reason = %error,
                trace_id = "",
                span_id = "",
                "Runtime Metrics stopped with an error"
            );
        }
        let tracer_provider = self
            .tracer_provider
            .take()
            .expect("Telemetry always owns one local tracer provider");
        if let Err(error) = tracer_provider
            .shutdown_with_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            let error_type = if self.trace_otlp_enabled {
                "otlp_trace_shutdown_failed"
            } else {
                "trace_shutdown_failed"
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
                trace_otlp_enabled = self.trace_otlp_enabled,
                metrics_otlp_enabled = self.metrics_otlp_enabled,
                trace_id = "",
                span_id = "",
                "Runtime telemetry stopped"
            );
        }
    }
}

impl TelemetryConfig {
    pub(crate) fn resolve(environment: TelemetryEnvironment) -> Self {
        let TelemetryEnvironment {
            image_reference,
            image_id,
            capture_rpc_content,
            log_filter,
            sdk_disabled,
            exporter,
            traces_endpoint,
            endpoint,
            traces_protocol,
            protocol,
            metrics_exporter,
            metrics_endpoint,
            metrics_protocol,
        } = environment;
        let export = resolve_export(
            sdk_disabled.as_deref(),
            exporter.as_deref(),
            traces_endpoint.as_deref(),
            endpoint.as_deref(),
        );
        let export = if export == ExportDecision::Otlp {
            resolve_protocol(traces_protocol.as_deref(), protocol.as_deref())
                .map_or_else(ExportDecision::Unsupported, |()| ExportDecision::Otlp)
        } else {
            export
        };
        let metrics_export = resolve_signal_export(
            "metrics",
            sdk_disabled.as_deref(),
            metrics_exporter.as_deref(),
            metrics_endpoint.as_deref(),
            endpoint.as_deref(),
        );
        let metrics_export = if metrics_export == ExportDecision::Otlp {
            resolve_signal_protocol("metrics", metrics_protocol.as_deref(), protocol.as_deref())
                .map_or_else(ExportDecision::Unsupported, |()| ExportDecision::Otlp)
        } else {
            metrics_export
        };
        Self {
            capture_rpc_content: capture_rpc_content
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("true")),
            image_reference: image_reference.unwrap_or_default(),
            image_id: image_id.unwrap_or_default(),
            log_filter: log_filter
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "info,hyper=warn,reqwest=warn".into()),
            export,
            endpoint: resolve_otlp_endpoint(
                traces_endpoint.as_deref(),
                endpoint.as_deref(),
                "/v1/traces",
            ),
            metrics_export,
            metrics_endpoint: resolve_otlp_endpoint(
                metrics_endpoint.as_deref(),
                endpoint.as_deref(),
                "/v1/metrics",
            ),
        }
    }
}

fn resolve_otlp_endpoint(
    signal_endpoint: Option<&str>,
    common_endpoint: Option<&str>,
    signal_path: &str,
) -> String {
    if let Some(endpoint) = signal_endpoint.filter(|value| !value.trim().is_empty()) {
        return endpoint.to_owned();
    }
    let endpoint = common_endpoint
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("http://127.0.0.1:4318");
    let Ok(mut endpoint) = url::Url::parse(endpoint) else {
        return endpoint.to_owned();
    };
    let path = format!("{}{}", endpoint.path().trim_end_matches('/'), signal_path);
    endpoint.set_path(&path);
    endpoint.to_string()
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

fn configured_tracer(
    identity: &RuntimeIdentity,
    platform: &PlatformNetwork,
    config: &TelemetryConfig,
    warnings: &mut Vec<TelemetryWarning>,
) -> (SdkTracerProvider, bool) {
    let provider = configured_export(
        &config.export,
        &config.endpoint,
        platform,
        "traces",
        warnings,
        |endpoint| build_otlp_provider(identity, config, endpoint),
    );
    let enabled = provider.is_some();
    (
        provider.unwrap_or_else(|| build_local_provider(identity, config)),
        enabled,
    )
}

fn configured_meter(
    platform: &PlatformNetwork,
    config: &TelemetryConfig,
    warnings: &mut Vec<TelemetryWarning>,
) -> (SdkMeterProvider, bool) {
    let provider = configured_export(
        &config.metrics_export,
        &config.metrics_endpoint,
        platform,
        "metrics",
        warnings,
        build_otlp_meter_provider,
    );
    let enabled = provider.is_some();
    (provider.unwrap_or_else(build_local_meter_provider), enabled)
}

fn configured_export<T>(
    decision: &ExportDecision,
    endpoint: &str,
    platform: &PlatformNetwork,
    signal: &'static str,
    warnings: &mut Vec<TelemetryWarning>,
    build: impl FnOnce(&str) -> Result<T, Box<dyn std::error::Error + Send + Sync>>,
) -> Option<T> {
    match decision {
        ExportDecision::Disabled => None,
        ExportDecision::Unsupported(warning) => {
            warnings.push(warning.clone());
            None
        }
        ExportDecision::Otlp => match validate_otlp_destination(endpoint, platform) {
            Err(reason) => {
                warnings.push(TelemetryWarning::new(
                    if signal == "metrics" {
                        "invalid_otlp_metrics_destination"
                    } else {
                        "invalid_otlp_trace_destination"
                    },
                    reason,
                ));
                None
            }
            Ok(endpoint) => match build(&endpoint) {
                Ok(provider) => Some(provider),
                Err(error) => {
                    warnings.push(TelemetryWarning::new(
                        if signal == "metrics" {
                            "otlp_metrics_exporter_initialization_failed"
                        } else {
                            "otlp_trace_exporter_initialization_failed"
                        },
                        error.to_string(),
                    ));
                    None
                }
            },
        },
    }
}

fn build_otlp_provider(
    identity: &RuntimeIdentity,
    config: &TelemetryConfig,
    endpoint: &str,
) -> Result<SdkTracerProvider, Box<dyn std::error::Error + Send + Sync>> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .build()?;
    Ok(SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(runtime_resource(identity, config))
        .build())
}

fn build_local_provider(identity: &RuntimeIdentity, config: &TelemetryConfig) -> SdkTracerProvider {
    SdkTracerProvider::builder()
        .with_resource(runtime_resource(identity, config))
        .build()
}

fn build_otlp_meter_provider(
    endpoint: &str,
) -> Result<SdkMeterProvider, Box<dyn std::error::Error + Send + Sync>> {
    let exporter = opentelemetry_otlp::MetricExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .build()?;
    Ok(SdkMeterProvider::builder()
        .with_periodic_exporter(exporter)
        .with_resource(metrics_resource())
        .build())
}

fn build_local_meter_provider() -> SdkMeterProvider {
    SdkMeterProvider::builder()
        .with_resource(metrics_resource())
        .build()
}

fn runtime_resource(identity: &RuntimeIdentity, config: &TelemetryConfig) -> Resource {
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
        .with_attributes(
            [
                ("antnest.runtime.image.reference", &config.image_reference),
                ("antnest.runtime.image.id", &config.image_id),
            ]
            .into_iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| KeyValue::new(key, value.clone())),
        )
        .build()
}

fn metrics_resource() -> Resource {
    Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attributes([
            KeyValue::new("service.namespace", "antnest"),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        ])
        .build()
}

fn resolve_export(
    sdk_disabled: Option<&str>,
    exporter: Option<&str>,
    traces_endpoint: Option<&str>,
    endpoint: Option<&str>,
) -> ExportDecision {
    resolve_signal_export("traces", sdk_disabled, exporter, traces_endpoint, endpoint)
}

fn resolve_signal_export(
    signal: &'static str,
    sdk_disabled: Option<&str>,
    exporter: Option<&str>,
    signal_endpoint: Option<&str>,
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
                if signal == "metrics" {
                    "unsupported_metrics_exporter"
                } else {
                    "unsupported_trace_exporter"
                },
                format!("OTEL_{}_EXPORTER={exporter}", signal.to_ascii_uppercase()),
            )),
        };
    }
    if [signal_endpoint, endpoint]
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
    resolve_signal_protocol("traces", traces_protocol, protocol)
}

fn resolve_signal_protocol(
    signal: &'static str,
    signal_protocol: Option<&str>,
    protocol: Option<&str>,
) -> Result<(), TelemetryWarning> {
    let (name, value) = if let Some(value) = signal_protocol
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        (
            if signal == "metrics" {
                "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"
            } else {
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"
            },
            value,
        )
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
    let context = TraceContextPropagator::new().extract(carrier);
    if !context.span().span_context().is_valid() {
        return;
    }
    let _ = span.set_parent(context);
}

pub(crate) fn mcp_client_context(span: &tracing::Span) -> rmcp::model::RequestMetaObject {
    let mut carrier = TraceContext::default();
    TraceContextPropagator::new().inject_context(&span.context(), &mut carrier);
    let mut meta = rmcp::model::RequestMetaObject::default();
    if !carrier.traceparent.is_empty() {
        meta.set_traceparent(carrier.traceparent);
    }
    if let Some(value) = carrier.tracestate {
        meta.set_tracestate(value);
    }
    meta
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

pub(crate) fn is_runtime_trace(metadata: &tracing::Metadata<'_>) -> bool {
    is_runtime_target(metadata.target())
}

fn is_runtime_log(metadata: &tracing::Metadata<'_>) -> bool {
    is_runtime_target(metadata.target())
}

fn is_runtime_target(target: &str) -> bool {
    target == "antnest_runtime" || target.starts_with("antnest_runtime::")
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use opentelemetry::trace::{TraceContextExt as _, TracerProvider as _};
    use opentelemetry::{global, metrics::MeterProvider as _};
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
    use opentelemetry_sdk::propagation::TraceContextPropagator;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tracing_opentelemetry::OpenTelemetrySpanExt as _;
    use tracing_subscriber::layer::{Layer as _, SubscriberExt as _};

    use crate::network::{PlatformNetwork, PlatformRoute};
    use crate::spec::RuntimeIdentity;

    use super::{
        ExportDecision, RuntimeMetrics, SERVICE_NAME, TelemetryConfig, TelemetryEnvironment,
        TelemetryWarning, TraceContext, build_local_provider, is_runtime_target, resolve_export,
        resolve_protocol, set_remote_parent, validate_otlp_destination,
    };

    #[test]
    fn log_target_boundary_excludes_dependencies_and_similar_names() {
        assert!(is_runtime_target("antnest_runtime"));
        assert!(is_runtime_target("antnest_runtime::mcp"));
        assert!(!is_runtime_target("hyper"));
        assert!(!is_runtime_target("antnest_runtime_external"));
    }

    #[test]
    fn build_image_metadata_is_on_trace_resource_not_metrics() {
        let identity = RuntimeIdentity::new("agent-image", 2).unwrap();
        let image_id = format!("sha256:{}", "a".repeat(64));
        let config = TelemetryConfig::resolve(TelemetryEnvironment {
            image_reference: Some("antnest/runtime:latest".into()),
            image_id: Some(image_id.clone()),
            ..Default::default()
        });
        let resource = super::runtime_resource(&identity, &config);
        assert_eq!(
            resource
                .get(&"antnest.runtime.image.reference".into())
                .unwrap()
                .as_str(),
            "antnest/runtime:latest"
        );
        assert_eq!(
            resource
                .get(&"antnest.runtime.image.id".into())
                .unwrap()
                .as_str(),
            image_id
        );
        assert!(
            super::metrics_resource()
                .get(&"antnest.runtime.image.id".into())
                .is_none()
        );
        let unknown = TelemetryConfig::resolve(TelemetryEnvironment::default());
        assert!(
            super::runtime_resource(&identity, &unknown)
                .get(&"antnest.runtime.image.id".into())
                .is_none()
        );
    }

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

        crate::test_tracing::stabilize_callsite_registry();
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
        let provider = build_local_provider(
            &identity,
            &TelemetryConfig::resolve(TelemetryEnvironment::default()),
        );
        let tracer = provider.tracer(SERVICE_NAME);
        let subscriber = tracing_subscriber::Registry::default()
            .with(tracing_opentelemetry::layer().with_tracer(tracer));
        let parent_trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
        let carrier = TraceContext {
            traceparent: format!("00-{parent_trace_id}-00f067aa0ba902b7-01"),
            tracestate: None,
        };

        crate::test_tracing::stabilize_callsite_registry();
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
            capture_rpc_content: None,
            log_filter: Some("debug".into()),
            sdk_disabled: None,
            exporter: Some("otlp".into()),
            traces_endpoint: Some("http://127.0.0.1:9000".into()),
            endpoint: Some("http://127.0.0.1:4318".into()),
            traces_protocol: Some("http/protobuf".into()),
            protocol: Some("grpc".into()),
            metrics_exporter: Some("otlp".into()),
            metrics_endpoint: Some("http://127.0.0.1:9001".into()),
            metrics_protocol: Some("http/protobuf".into()),
            ..Default::default()
        });
        assert_eq!(config.log_filter, "debug");
        assert_eq!(config.export, ExportDecision::Otlp);
        assert_eq!(config.endpoint, "http://127.0.0.1:9000");
        assert_eq!(config.metrics_export, ExportDecision::Otlp);
        assert_eq!(config.metrics_endpoint, "http://127.0.0.1:9001");
    }

    #[test]
    fn common_otlp_endpoint_expands_standard_signal_paths() {
        let config = TelemetryConfig::resolve(TelemetryEnvironment {
            capture_rpc_content: None,
            log_filter: None,
            sdk_disabled: None,
            exporter: Some("otlp".into()),
            traces_endpoint: None,
            endpoint: Some("http://127.0.0.1:4318/collector".into()),
            traces_protocol: None,
            protocol: Some("http/protobuf".into()),
            metrics_exporter: Some("otlp".into()),
            metrics_endpoint: None,
            metrics_protocol: None,
            ..Default::default()
        });

        assert_eq!(config.endpoint, "http://127.0.0.1:4318/collector/v1/traces");
        assert_eq!(
            config.metrics_endpoint,
            "http://127.0.0.1:4318/collector/v1/metrics"
        );
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

    #[test]
    fn managed_metadata_injects_the_client_span_as_the_receiving_parent() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::Registry::default()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer(SERVICE_NAME)));
        let mut injected_parent = None;
        crate::test_tracing::stabilize_callsite_registry();
        tracing::subscriber::with_default(subscriber, || {
            let parent = tracing::info_span!("runtime.mcp.tool");
            let client =
                tracing::info_span!(parent: &parent, "runtime.mcp.stdio", otel.kind = "client");
            let context = client.context();
            injected_parent = Some(context.span().span_context().span_id());
            let meta = super::mcp_client_context(&client);
            assert!(meta.get_baggage().is_none());
            let remote = TraceContext {
                traceparent: meta.get_traceparent().unwrap().into(),
                tracestate: meta.get_tracestate().map(str::to_owned),
            };
            let receiving =
                tracing::info_span!(parent: None, "managed.receiving", otel.kind = "server");
            set_remote_parent(&receiving, Some(&remote));
        });
        provider.force_flush().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        let receiving = spans
            .iter()
            .find(|span| span.name == "managed.receiving")
            .unwrap();
        let client = spans
            .iter()
            .find(|span| span.name == "runtime.mcp.stdio")
            .unwrap();
        let tool = spans
            .iter()
            .find(|span| span.name == "runtime.mcp.tool")
            .unwrap();
        assert_eq!(receiving.parent_span_id, injected_parent.unwrap());
        assert_eq!(client.parent_span_id, tool.span_context.span_id());
        assert_eq!(
            receiving.span_context.trace_id(),
            client.span_context.trace_id()
        );
        assert_ne!(receiving.parent_span_id, tool.span_context.span_id());
        provider.shutdown().unwrap();
    }

    #[test]
    fn runtime_metrics_export_each_operational_layer() {
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let metrics = RuntimeMetrics::new(provider.meter(SERVICE_NAME));

        metrics.http(
            "POST",
            "/mcp",
            "error",
            "http_body_error",
            std::time::Duration::from_millis(2),
        );
        metrics.mcp(
            "tools/call",
            "success",
            "",
            std::time::Duration::from_millis(3),
        );
        metrics.tool("read", "success", "", std::time::Duration::from_millis(4));
        metrics.executor("read", "success", "", std::time::Duration::from_millis(5));
        metrics.network_outbound(64);
        metrics.network_connection_refused();
        metrics.network_connection_refused();
        provider.force_flush().unwrap();

        let exported = exporter.get_finished_metrics().unwrap();
        let names = exported
            .iter()
            .flat_map(|resource| resource.scope_metrics())
            .flat_map(|scope| scope.metrics())
            .map(|metric| metric.name().to_owned())
            .collect::<Vec<_>>();
        for name in [
            "antnest.runtime.http.requests",
            "antnest.runtime.mcp.operations",
            "antnest.runtime.tool.calls",
            "antnest.runtime.executor.calls",
            "antnest.runtime.network.outbound.packets",
            "antnest.runtime.network.connection_refused",
        ] {
            assert!(names.contains(&name.to_owned()), "missing metric {name}");
        }
        let refused = exported
            .iter()
            .flat_map(|resource| resource.scope_metrics())
            .flat_map(|scope| scope.metrics())
            .find(|metric| metric.name() == "antnest.runtime.network.connection_refused")
            .unwrap();
        let opentelemetry_sdk::metrics::data::AggregatedMetrics::U64(
            opentelemetry_sdk::metrics::data::MetricData::Sum(sum),
        ) = refused.data()
        else {
            panic!("refusals must be an integer counter");
        };
        let points = sum.data_points().collect::<Vec<_>>();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].value(), 2);
        assert_eq!(points[0].attributes().count(), 0);
        provider.shutdown().unwrap();
    }
}
