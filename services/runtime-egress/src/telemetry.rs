use crate::semconv;

use std::{
    env,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use opentelemetry::{
    KeyValue, global,
    metrics::{Counter, Gauge, Histogram, Meter, MeterProvider as _},
    trace::{TraceContextExt as _, TracerProvider as _},
};
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::{
    Resource, metrics::SdkMeterProvider, propagation::TraceContextPropagator,
    trace::SdkTracerProvider,
};
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;
use tracing_subscriber::{
    Layer as _, Registry,
    filter::{EnvFilter, FilterExt as _, filter_fn},
    layer::SubscriberExt,
    util::SubscriberInitExt,
};

pub const SERVICE_NAME: &str = "antnest-runtime-egress";

const OTLP_EXPORT_TIMEOUT: Duration = Duration::from_secs(2);

pub fn capture_rpc_content_from_environment() -> bool {
    env::var("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

#[derive(Debug, Error)]
pub enum TelemetryError {
    #[error("initialize OTLP exporter: {0}")]
    Exporter(String),
    #[error("install tracing subscriber: {0}")]
    Subscriber(String),
}

pub struct Telemetry {
    tracer_provider: Option<SdkTracerProvider>,
    meter_provider: Option<SdkMeterProvider>,
    metrics: EgressMetrics,
    otlp_enabled: bool,
    metrics_enabled: bool,
}

#[derive(Clone, Debug)]
pub struct EgressMetrics {
    control_requests: Counter<u64>,
    control_duration_ms: Histogram<f64>,
    service_ready: Gauge<u64>,
    data_plane_ready: Gauge<u64>,
    control_plane_ready: Gauge<u64>,
    fenced_agents: Gauge<u64>,
    health_transitions: Counter<u64>,
    quarantine_removed: Counter<u64>,
    quarantine_cleanup_failures: Counter<u64>,
    data_plane: DataPlaneInstruments,
    observed_peer_mismatches: Arc<AtomicU64>,
    observed_dns_filtered_answers: Arc<AtomicU64>,
}

#[derive(Clone, Debug)]
struct DataPlaneInstruments {
    authentication_drops: Gauge<u64>,
    replay_drops: Gauge<u64>,
    unknown_context_drops: Gauge<u64>,
    uplink_packets: Gauge<u64>,
    uplink_bytes: Gauge<u64>,
    downlink_packets: Gauge<u64>,
    downlink_bytes: Gauge<u64>,
    policy_allows: Gauge<u64>,
    policy_denials: Gauge<u64>,
    malformed_packets: Gauge<u64>,
    unsupported_packets: Gauge<u64>,
    unknown_agents: Gauge<u64>,
    fenced_packets: Gauge<u64>,
    active_flows: Gauge<u64>,
    flow_expirations: Gauge<u64>,
    flow_collisions: Gauge<u64>,
    flow_capacity_rejections: Gauge<u64>,
    reverse_flow_misses: Gauge<u64>,
    peer_output_failures: Gauge<u64>,
    peer_mismatches: Counter<u64>,
    unattributed_udp_receive_errors: Gauge<u64>,
    dns_accepted: Gauge<u64>,
    dns_rejected: Gauge<u64>,
    dns_completed: Gauge<u64>,
    dns_proxy_failures: Gauge<u64>,
    dns_client_bytes: Gauge<u64>,
    dns_upstream_bytes: Gauge<u64>,
    dns_filtered_answers: Counter<u64>,
}

impl Telemetry {
    pub fn init() -> Result<Self, TelemetryError> {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let filter = env::var("RUST_LOG")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .and_then(|value| EnvFilter::try_new(value).ok())
            .unwrap_or_else(|| EnvFilter::new("info,hyper=warn,reqwest=warn"));
        let console = tracing_subscriber::fmt::layer()
            .json()
            .with_ansi(false)
            .with_target(true)
            .with_current_span(true)
            .flatten_event(true)
            .with_filter(filter_fn(is_service_log).and(filter.clone()))
            .boxed();

        let otlp_enabled = !sdk_disabled();
        let metrics_exporter = env::var("OTEL_METRICS_EXPORTER").ok();
        let metrics_enabled = metrics_export_enabled(otlp_enabled, metrics_exporter.as_deref());
        let metrics_exporter_rejected =
            !metrics_exporter_supported(otlp_enabled, metrics_exporter.as_deref());
        let tracer_provider = if !otlp_enabled {
            SdkTracerProvider::builder()
                .with_max_events_per_span(32)
                .with_resource(service_resource())
                .build()
        } else {
            let endpoint =
                configured_otlp_endpoint("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "v1/traces");
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .with_endpoint(endpoint)
                .with_timeout(OTLP_EXPORT_TIMEOUT)
                .build()
                .map_err(|error| TelemetryError::Exporter(error.to_string()))?;
            SdkTracerProvider::builder()
                .with_max_events_per_span(32)
                .with_batch_exporter(exporter)
                .with_resource(service_resource())
                .build()
        };
        let meter_provider = if !metrics_enabled {
            SdkMeterProvider::builder()
                .with_resource(service_resource())
                .build()
        } else {
            let endpoint =
                configured_otlp_endpoint("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "v1/metrics");
            let exporter = opentelemetry_otlp::MetricExporter::builder()
                .with_http()
                .with_endpoint(endpoint)
                .with_timeout(OTLP_EXPORT_TIMEOUT)
                .build()
                .map_err(|error| TelemetryError::Exporter(error.to_string()))?;
            SdkMeterProvider::builder()
                .with_periodic_exporter(exporter)
                .with_resource(service_resource())
                .build()
        };
        let metrics = EgressMetrics::new(meter_provider.meter(SERVICE_NAME));
        let tracer = tracer_provider.tracer(SERVICE_NAME);
        let otlp_layer = tracing_opentelemetry::layer()
            .with_tracer(tracer)
            .with_filter(filter_fn(|metadata| {
                is_control_otlp_target(metadata.target())
            }))
            .boxed();
        Registry::default()
            .with(console)
            .with(otlp_layer)
            .try_init()
            .map_err(|error| TelemetryError::Subscriber(error.to_string()))?;
        global::set_tracer_provider(tracer_provider.clone());
        global::set_meter_provider(meter_provider.clone());
        tracing::info!(
            "service.name" = SERVICE_NAME,
            "service.version" = env!("CARGO_PKG_VERSION"),
            otlp_enabled,
            metrics_enabled,
            "Runtime Egress telemetry initialized"
        );
        if metrics_exporter_rejected {
            tracing::warn!("{UNSUPPORTED_METRICS_EXPORTER_WARNING}");
        }
        Ok(Self {
            tracer_provider: Some(tracer_provider),
            meter_provider: Some(meter_provider),
            metrics,
            otlp_enabled,
            metrics_enabled,
        })
    }

    pub fn metrics(&self) -> EgressMetrics {
        self.metrics.clone()
    }

    pub fn shutdown(mut self) {
        let mut metrics_status = if self.metrics_enabled {
            "stopped"
        } else {
            "disabled"
        };
        let mut tracing_status = if self.otlp_enabled {
            "stopped"
        } else {
            "disabled"
        };
        if let Some(provider) = self.meter_provider.take()
            && let Err(error) = provider.shutdown_with_timeout(Duration::from_secs(5))
        {
            metrics_status = "failed";
            tracing::error!(%error, "Runtime Egress metrics shutdown failed");
        }
        if let Some(provider) = self.tracer_provider.take()
            && let Err(error) = provider.shutdown_with_timeout(Duration::from_secs(5))
        {
            tracing_status = "failed";
            tracing::error!(%error, "Runtime Egress tracing shutdown failed");
        }
        if metrics_status == "failed" || tracing_status == "failed" {
            tracing::warn!(
                otlp_enabled = self.otlp_enabled,
                metrics_enabled = self.metrics_enabled,
                metrics_status,
                tracing_status,
                export_delivery = "unverified",
                "Runtime Egress telemetry stopped with export failures"
            );
        } else {
            tracing::info!(
                otlp_enabled = self.otlp_enabled,
                metrics_enabled = self.metrics_enabled,
                metrics_status,
                tracing_status,
                export_delivery = "unverified",
                "Runtime Egress telemetry stopped"
            );
        }
    }
}

pub(crate) trait TelemetrySpanExt {
    fn set_contract_attribute(
        &self,
        key: impl Into<opentelemetry::Key>,
        value: impl Into<opentelemetry::Value>,
    );
    fn set_contract_attributes(
        &self,
        attributes: impl IntoIterator<Item = opentelemetry::KeyValue>,
    );
    fn add_contract_event(&self, name: &'static str, attributes: Vec<opentelemetry::KeyValue>);
}

impl TelemetrySpanExt for tracing::Span {
    fn set_contract_attribute(
        &self,
        key: impl Into<opentelemetry::Key>,
        value: impl Into<opentelemetry::Value>,
    ) {
        self.set_contract_attributes([opentelemetry::KeyValue::new(key, value)]);
    }

    fn set_contract_attributes(
        &self,
        attributes: impl IntoIterator<Item = opentelemetry::KeyValue>,
    ) {
        for attribute in
            crate::telemetry_contract::alias_attributes(attributes.into_iter().collect())
        {
            tracing_opentelemetry::OpenTelemetrySpanExt::set_attribute(
                self,
                attribute.key,
                attribute.value,
            );
        }
    }

    fn add_contract_event(&self, name: &'static str, attributes: Vec<opentelemetry::KeyValue>) {
        tracing_opentelemetry::OpenTelemetrySpanExt::add_event(
            self,
            name,
            crate::telemetry_contract::alias_attributes(attributes),
        );
    }
}

impl EgressMetrics {
    fn new(meter: Meter) -> Self {
        Self {
            control_requests: meter
                .u64_counter(semconv::ANTNEST_EGRESS_CONTROL_REQUESTS)
                .with_description("Completed Runtime Egress control requests")
                .build(),
            control_duration_ms: meter
                .f64_histogram(semconv::ANTNEST_EGRESS_CONTROL_DURATION)
                .with_description("Runtime Egress control request latency")
                .with_unit("ms")
                .build(),
            service_ready: meter
                .u64_gauge(semconv::ANTNEST_EGRESS_HEALTH_READY)
                .with_description("Whether Runtime Egress is globally ready")
                .build(),
            data_plane_ready: meter
                .u64_gauge(semconv::ANTNEST_EGRESS_HEALTH_DATA_PLANE_READY)
                .with_description("Whether the Runtime Egress data plane is ready")
                .build(),
            control_plane_ready: meter
                .u64_gauge(semconv::ANTNEST_EGRESS_HEALTH_CONTROL_PLANE_READY)
                .with_description("Whether shared control infrastructure is ready")
                .build(),
            fenced_agents: meter
                .u64_gauge(semconv::ANTNEST_EGRESS_HEALTH_FENCED_AGENTS)
                .with_description("Number of Agent packet paths currently fenced")
                .build(),
            health_transitions: meter
                .u64_counter(semconv::ANTNEST_EGRESS_HEALTH_TRANSITIONS)
                .with_description("Runtime Egress shared health state transitions")
                .build(),
            quarantine_removed: meter
                .u64_counter(semconv::ANTNEST_EGRESS_QUARANTINE_REMOVED)
                .with_description("Expired Agent network allocations removed")
                .build(),
            quarantine_cleanup_failures: meter
                .u64_counter(semconv::ANTNEST_EGRESS_QUARANTINE_CLEANUP_FAILURES)
                .with_description("Agent-local kernel cleanup failures during quarantine sweeps")
                .build(),
            data_plane: DataPlaneInstruments::new(&meter),
            observed_peer_mismatches: Arc::new(AtomicU64::new(0)),
            observed_dns_filtered_answers: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn control(
        &self,
        method: &str,
        route: &str,
        status: u16,
        outcome: &'static str,
        error_type: &'static str,
        duration: Duration,
    ) {
        let mut attributes = vec![
            KeyValue::new("http.request.method", method.to_owned()),
            KeyValue::new("http.route", route.to_owned()),
            KeyValue::new("http.response.status_code", i64::from(status)),
            KeyValue::new("outcome", outcome),
        ];
        if !error_type.is_empty() {
            attributes.push(KeyValue::new("error.type", error_type));
        }
        let attributes = crate::telemetry_contract::metric_attributes(attributes);
        self.control_requests.add(1, &attributes);
        self.control_duration_ms
            .record(duration.as_secs_f64() * 1000.0, &attributes);
    }

    pub fn data_plane(
        &self,
        data: crate::dataplane::DataPlaneMetrics,
        dns: crate::dns::DnsMetricsSnapshot,
    ) {
        let instruments = &self.data_plane;
        instruments
            .authentication_drops
            .record(data.authentication_drops, &[]);
        instruments.replay_drops.record(data.replay_drops, &[]);
        instruments
            .unknown_context_drops
            .record(data.unknown_context_drops, &[]);
        let previous = self
            .observed_peer_mismatches
            .fetch_max(data.peer_mismatches, Ordering::Relaxed);
        let delta = data.peer_mismatches.saturating_sub(previous);
        if delta != 0 {
            instruments.peer_mismatches.add(delta, &[]);
        }
        instruments.uplink_packets.record(data.uplink_packets, &[]);
        instruments.uplink_bytes.record(data.uplink_bytes, &[]);
        instruments
            .downlink_packets
            .record(data.downlink_packets, &[]);
        instruments.downlink_bytes.record(data.downlink_bytes, &[]);
        instruments.policy_allows.record(data.policy_allows, &[]);
        instruments.policy_denials.record(data.policy_denials, &[]);
        instruments
            .malformed_packets
            .record(data.malformed_packets, &[]);
        instruments
            .unsupported_packets
            .record(data.unsupported_packets, &[]);
        instruments.unknown_agents.record(data.unknown_agents, &[]);
        instruments.fenced_packets.record(data.fenced_packets, &[]);
        instruments
            .active_flows
            .record(u64::try_from(data.active_flows).unwrap_or(u64::MAX), &[]);
        instruments
            .flow_expirations
            .record(data.flow_expirations, &[]);
        instruments
            .flow_collisions
            .record(data.flow_collisions, &[]);
        instruments
            .flow_capacity_rejections
            .record(data.flow_capacity_rejections, &[]);
        instruments
            .reverse_flow_misses
            .record(data.reverse_flow_misses, &[]);
        instruments
            .peer_output_failures
            .record(data.peer_output_failures, &[]);
        instruments
            .unattributed_udp_receive_errors
            .record(data.unattributed_udp_receive_errors, &[]);
        instruments
            .dns_accepted
            .record(dns.accepted_connections, &[]);
        instruments
            .dns_rejected
            .record(dns.rejected_connections, &[]);
        instruments
            .dns_completed
            .record(dns.completed_connections, &[]);
        instruments
            .dns_proxy_failures
            .record(dns.proxy_failures, &[]);
        instruments
            .dns_client_bytes
            .record(dns.client_to_upstream_bytes, &[]);
        instruments
            .dns_upstream_bytes
            .record(dns.upstream_to_client_bytes, &[]);
        let previous = self
            .observed_dns_filtered_answers
            .fetch_max(dns.filtered_answers, Ordering::Relaxed);
        let delta = dns.filtered_answers.saturating_sub(previous);
        if delta != 0 {
            instruments.dns_filtered_answers.add(delta, &[]);
        }
    }

    pub fn health(
        &self,
        snapshot: crate::application::HealthMetricsSnapshot,
        transition_delta: u64,
    ) {
        self.service_ready
            .record(u64::from(snapshot.service_ready), &[]);
        self.data_plane_ready
            .record(u64::from(snapshot.data_plane_ready), &[]);
        self.control_plane_ready
            .record(u64::from(snapshot.control_plane_ready), &[]);
        self.fenced_agents.record(
            u64::try_from(snapshot.fenced_agents).unwrap_or(u64::MAX),
            &[],
        );
        self.health_transitions.add(transition_delta, &[]);
    }

    pub fn quarantine_sweep(&self, report: crate::application::SweepReport) {
        self.quarantine_removed
            .add(u64::try_from(report.removed).unwrap_or(u64::MAX), &[]);
        self.quarantine_cleanup_failures.add(
            u64::try_from(report.cleanup_failures).unwrap_or(u64::MAX),
            &[],
        );
    }
}

impl Default for EgressMetrics {
    fn default() -> Self {
        let provider = opentelemetry::metrics::NoopMeterProvider::new();
        Self::new(provider.meter(SERVICE_NAME))
    }
}

impl DataPlaneInstruments {
    fn new(meter: &Meter) -> Self {
        fn gauge(meter: &Meter, name: &'static str) -> Gauge<u64> {
            meter.u64_gauge(name).build()
        }
        Self {
            authentication_drops: gauge(meter, semconv::ANTNEST_EGRESS_TUNNEL_AUTHENTICATION_DROPS),
            replay_drops: gauge(meter, semconv::ANTNEST_EGRESS_TUNNEL_REPLAY_DROPS),
            unknown_context_drops: gauge(
                meter,
                semconv::ANTNEST_EGRESS_TUNNEL_UNKNOWN_CONTEXT_DROPS,
            ),
            uplink_packets: gauge(meter, semconv::ANTNEST_EGRESS_UPLINK_PACKETS),
            uplink_bytes: gauge(meter, semconv::ANTNEST_EGRESS_UPLINK_BYTES),
            downlink_packets: gauge(meter, semconv::ANTNEST_EGRESS_DOWNLINK_PACKETS),
            downlink_bytes: gauge(meter, semconv::ANTNEST_EGRESS_DOWNLINK_BYTES),
            policy_allows: gauge(meter, semconv::ANTNEST_EGRESS_POLICY_ALLOWS),
            policy_denials: gauge(meter, semconv::ANTNEST_EGRESS_POLICY_DENIALS),
            malformed_packets: gauge(meter, semconv::ANTNEST_EGRESS_PACKET_MALFORMED),
            unsupported_packets: gauge(meter, semconv::ANTNEST_EGRESS_PACKET_UNSUPPORTED),
            unknown_agents: gauge(meter, semconv::ANTNEST_EGRESS_AGENT_UNKNOWN),
            fenced_packets: gauge(meter, semconv::ANTNEST_EGRESS_AGENT_FENCED_PACKETS),
            active_flows: gauge(meter, semconv::ANTNEST_EGRESS_FLOW_ACTIVE),
            flow_expirations: gauge(meter, semconv::ANTNEST_EGRESS_FLOW_EXPIRATIONS),
            flow_collisions: gauge(meter, semconv::ANTNEST_EGRESS_FLOW_COLLISIONS),
            flow_capacity_rejections: gauge(
                meter,
                semconv::ANTNEST_EGRESS_FLOW_CAPACITY_REJECTIONS,
            ),
            reverse_flow_misses: gauge(meter, semconv::ANTNEST_EGRESS_FLOW_REVERSE_MISSES),
            peer_output_failures: gauge(meter, semconv::ANTNEST_EGRESS_PEER_OUTPUT_FAILURES),
            peer_mismatches: meter
                .u64_counter(semconv::ANTNEST_EGRESS_PEER_MISMATCH_DROPS)
                .with_description(
                    "Packets dropped because the outer IPv4 differs from the bound Runtime peer",
                )
                .build(),
            unattributed_udp_receive_errors: gauge(
                meter,
                semconv::ANTNEST_EGRESS_UDP_RECEIVE_ERRORS_UNATTRIBUTED,
            ),
            dns_accepted: gauge(meter, semconv::ANTNEST_EGRESS_DNS_CONNECTIONS_ACCEPTED),
            dns_rejected: gauge(meter, semconv::ANTNEST_EGRESS_DNS_CONNECTIONS_REJECTED),
            dns_completed: gauge(meter, semconv::ANTNEST_EGRESS_DNS_CONNECTIONS_COMPLETED),
            dns_proxy_failures: gauge(meter, semconv::ANTNEST_EGRESS_DNS_PROXY_FAILURES),
            dns_client_bytes: gauge(meter, semconv::ANTNEST_EGRESS_DNS_CLIENT_TO_UPSTREAM_BYTES),
            dns_upstream_bytes: gauge(meter, semconv::ANTNEST_EGRESS_DNS_UPSTREAM_TO_CLIENT_BYTES),
            dns_filtered_answers: meter
                .u64_counter(semconv::ANTNEST_EGRESS_DNS_ANSWERS_FILTERED)
                .with_description("DNS answer records removed by the external-only resolver policy")
                .build(),
        }
    }
}

pub fn record_span_identity(span: &tracing::Span) {
    let context = span.context();
    let current = context.span();
    let span_context = current.span_context();
    if !span_context.is_valid() {
        return;
    }
    span.record("trace_id", span_context.trace_id().to_string());
    span.record("span_id", span_context.span_id().to_string());
}

fn sdk_disabled() -> bool {
    env::var("OTEL_SDK_DISABLED")
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1"))
        .unwrap_or(true)
}

const UNSUPPORTED_METRICS_EXPORTER_WARNING: &str =
    "OTEL_METRICS_EXPORTER is not supported; Runtime Egress metrics export disabled";

fn metrics_exporter_value(exporter: Option<&str>) -> Option<&str> {
    exporter.map(str::trim).filter(|value| !value.is_empty())
}

fn metrics_export_enabled(sdk_enabled: bool, exporter: Option<&str>) -> bool {
    sdk_enabled
        && metrics_exporter_value(exporter).is_some_and(|value| value.eq_ignore_ascii_case("otlp"))
}

fn metrics_exporter_supported(sdk_enabled: bool, exporter: Option<&str>) -> bool {
    !sdk_enabled
        || metrics_exporter_value(exporter).is_none_or(|value| {
            value.eq_ignore_ascii_case("otlp") || value.eq_ignore_ascii_case("none")
        })
}

fn configured_otlp_endpoint(signal_key: &str, signal_path: &str) -> String {
    let specific = env::var(signal_key).ok();
    let generic = env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();
    resolve_otlp_endpoint(specific.as_deref(), generic.as_deref(), signal_path)
}

fn resolve_otlp_endpoint(
    specific: Option<&str>,
    generic: Option<&str>,
    signal_path: &str,
) -> String {
    if let Some(endpoint) = specific.map(str::trim).filter(|value| !value.is_empty()) {
        return endpoint.to_owned();
    }
    let base = generic
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http://127.0.0.1:4318");
    format!("{}/{signal_path}", base.trim_end_matches('/'))
}

fn service_resource() -> Resource {
    static RESOURCE: std::sync::OnceLock<Resource> = std::sync::OnceLock::new();
    RESOURCE
        .get_or_init(|| {
            let configured = Resource::builder().build();
            let started = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            Resource::builder_empty()
                .with_attributes([
                    KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                    KeyValue::new(
                        "service.instance.id",
                        format!("{}-{}-{started}", SERVICE_NAME, std::process::id()),
                    ),
                    KeyValue::new("deployment.environment.name", "unspecified"),
                ])
                .with_attributes(
                    configured
                        .iter()
                        .map(|(key, value)| KeyValue::new(key.clone(), value.clone())),
                )
                .with_service_name(SERVICE_NAME)
                .with_attribute(KeyValue::new("service.namespace", "antnest"))
                .build()
        })
        .clone()
}

fn is_control_otlp_target(target: &str) -> bool {
    target == "antnest_runtime_egress::control"
        || target == "antnest_runtime_egress::repository::observation"
}

fn is_service_log(metadata: &tracing::Metadata<'_>) -> bool {
    is_service_target(metadata.target())
}

fn is_service_target(target: &str) -> bool {
    target == "antnest_runtime_egress" || target.starts_with("antnest_runtime_egress::")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use opentelemetry::metrics::MeterProvider as _;
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};

    use super::{
        EgressMetrics, SERVICE_NAME, is_control_otlp_target, is_service_target,
        metrics_export_enabled, metrics_exporter_supported,
    };

    #[test]
    fn generic_otlp_endpoint_is_a_base_url() {
        assert_eq!(
            super::resolve_otlp_endpoint(None, Some("http://jaeger:4318"), "v1/traces"),
            "http://jaeger:4318/v1/traces"
        );
        assert_eq!(
            super::resolve_otlp_endpoint(None, Some("http://collector:4318/base/"), "v1/metrics"),
            "http://collector:4318/base/v1/metrics"
        );
    }

    #[test]
    fn signal_specific_otlp_endpoint_is_not_rewritten() {
        assert_eq!(
            super::resolve_otlp_endpoint(
                Some("http://collector:4318/custom-traces"),
                Some("http://jaeger:4318"),
                "v1/traces"
            ),
            "http://collector:4318/custom-traces"
        );
    }
    #[test]
    fn metrics_export_requires_explicit_otlp_opt_in() {
        for exporter in [None, Some(""), Some("   "), Some("none"), Some("NONE")] {
            assert!(!metrics_export_enabled(true, exporter), "{exporter:?}");
        }
        for exporter in [Some("otlp"), Some(" OTLP ")] {
            assert!(metrics_export_enabled(true, exporter), "{exporter:?}");
        }
        for exporter in [Some("grpc"), Some("otlp,trace")] {
            assert!(!metrics_export_enabled(true, exporter), "{exporter:?}");
        }
        for exporter in [None, Some("otlp"), Some("grpc")] {
            assert!(!metrics_export_enabled(false, exporter), "{exporter:?}");
        }
    }

    #[test]
    fn unsupported_metrics_exporter_is_detected_only_when_sdk_enabled() {
        for exporter in [
            None,
            Some(""),
            Some("   "),
            Some("none"),
            Some("NoNe"),
            Some("otlp"),
            Some(" OTLP "),
        ] {
            assert!(metrics_exporter_supported(true, exporter), "{exporter:?}");
        }
        for exporter in [Some("grpc"), Some("otlp,trace")] {
            assert!(!metrics_exporter_supported(true, exporter), "{exporter:?}");
        }
        for exporter in [None, Some("grpc")] {
            assert!(metrics_exporter_supported(false, exporter), "{exporter:?}");
        }
    }

    use crate::{
        application::HealthMetricsSnapshot, dataplane::DataPlaneMetrics, dns::DnsMetricsSnapshot,
    };

    #[test]
    fn log_target_boundary_excludes_dependencies_and_similar_names() {
        assert!(is_service_target("antnest_runtime_egress"));
        assert!(is_service_target("antnest_runtime_egress::control"));
        assert!(!is_service_target("tokio_postgres"));
        assert!(!is_service_target("antnest_runtime_egress_external"));
    }

    #[test]
    fn otlp_boundary_excludes_every_data_plane_target() {
        assert!(is_control_otlp_target("antnest_runtime_egress::control"));
        assert!(is_control_otlp_target(
            "antnest_runtime_egress::repository::observation"
        ));
        assert!(!is_control_otlp_target("antnest_runtime_egress::dataplane"));
        assert!(!is_control_otlp_target("antnest_runtime_egress::network"));
        assert!(!is_control_otlp_target("antnest_runtime_egress::dns"));
        assert!(!is_control_otlp_target("antnest_runtime_egress"));
    }

    #[test]
    fn metrics_export_control_and_aggregate_data_plane_signals() {
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let metrics = EgressMetrics::new(provider.meter(SERVICE_NAME));

        metrics.control(
            "PUT",
            "/internal/agent-networks/{agent_id}",
            200,
            "success",
            "",
            Duration::from_millis(4),
        );
        metrics.data_plane(
            DataPlaneMetrics {
                uplink_packets: 2,
                unsupported_packets: 1,
                unattributed_udp_receive_errors: 1,
                active_flows: 1,
                ..DataPlaneMetrics::default()
            },
            DnsMetricsSnapshot {
                accepted_connections: 1,
                rejected_connections: 0,
                completed_connections: 1,
                proxy_failures: 1,
                client_to_upstream_bytes: 20,
                upstream_to_client_bytes: 40,
                filtered_answers: 0,
            },
        );
        metrics.health(
            HealthMetricsSnapshot {
                service_ready: true,
                data_plane_ready: true,
                control_plane_ready: true,
                fenced_agents: 1,
                transitions: 3,
            },
            3,
        );
        metrics.quarantine_sweep(crate::application::SweepReport {
            examined: 2,
            removed: 1,
            cleanup_failures: 1,
        });
        provider.force_flush().unwrap();

        let exported = exporter.get_finished_metrics().unwrap();
        let names = exported
            .iter()
            .flat_map(|resource| resource.scope_metrics())
            .flat_map(|scope| scope.metrics())
            .map(|metric| metric.name().to_owned())
            .collect::<Vec<_>>();
        assert!(names.contains(&"antnest.egress.control.requests".to_owned()));
        assert!(names.contains(&"antnest.egress.control.duration".to_owned()));
        assert!(names.contains(&"antnest.egress.uplink.packets".to_owned()));
        for name in [
            "authentication_drops",
            "replay_drops",
            "unknown_context_drops",
        ] {
            assert!(names.contains(&format!("antnest.egress.tunnel.{name}")));
        }
        assert!(names.contains(&"antnest.egress.packet.unsupported".to_owned()));
        assert!(names.contains(&"antnest.egress.udp.receive_errors.unattributed".to_owned()));
        assert!(names.contains(&"antnest.egress.dns.connections.accepted".to_owned()));
        assert!(names.contains(&"antnest.egress.dns.proxy.failures".to_owned()));
        assert!(names.contains(&"antnest.egress.health.ready".to_owned()));
        assert!(names.contains(&"antnest.egress.health.fenced_agents".to_owned()));
        assert!(names.contains(&"antnest.egress.health.transitions".to_owned()));
        assert!(names.contains(&"antnest.egress.quarantine.removed".to_owned()));
        assert!(names.contains(&"antnest.egress.quarantine.cleanup_failures".to_owned()));
        provider.shutdown().unwrap();
    }

    #[test]
    fn dns_filtered_answers_are_a_content_free_counter_without_double_counting() {
        use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let metrics = EgressMetrics::new(provider.meter(SERVICE_NAME));
        for value in [2, 2, 4, 3] {
            metrics.clone().data_plane(
                DataPlaneMetrics::default(),
                DnsMetricsSnapshot {
                    filtered_answers: value,
                    ..Default::default()
                },
            );
        }
        provider.force_flush().unwrap();
        let exported = exporter.get_finished_metrics().unwrap();
        let metric = exported
            .iter()
            .flat_map(|resource| resource.scope_metrics())
            .flat_map(|scope| scope.metrics())
            .find(|metric| metric.name() == "antnest.egress.dns.answers.filtered")
            .expect("DNS filtered answer counter missing");
        let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
            panic!("DNS filtered answers are not a counter");
        };
        assert!(sum.is_monotonic());
        let points: Vec<_> = sum.data_points().collect();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].value(), 4);
        assert_eq!(points[0].attributes().count(), 0);
        provider.shutdown().unwrap();
    }

    #[test]
    fn peer_mismatch_is_a_monotonic_content_free_counter_without_double_counting() {
        use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let metrics = EgressMetrics::new(provider.meter(SERVICE_NAME));
        for value in [2, 2, 4, 3] {
            metrics.clone().data_plane(
                DataPlaneMetrics {
                    peer_mismatches: value,
                    ..Default::default()
                },
                DnsMetricsSnapshot {
                    accepted_connections: 0,
                    rejected_connections: 0,
                    completed_connections: 0,
                    proxy_failures: 0,
                    client_to_upstream_bytes: 0,
                    upstream_to_client_bytes: 0,
                    filtered_answers: 0,
                },
            );
        }
        provider.force_flush().unwrap();
        let exported = exporter.get_finished_metrics().unwrap();
        let metric = exported
            .iter()
            .flat_map(|resource| resource.scope_metrics())
            .flat_map(|scope| scope.metrics())
            .find(|metric| metric.name() == "antnest.egress.peer_mismatch.drops")
            .expect("peer mismatch counter missing");
        let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
            panic!("peer mismatch is not a counter");
        };
        assert!(sum.is_monotonic());
        let points: Vec<_> = sum.data_points().collect();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].value(), 4);
        assert_eq!(points[0].attributes().count(), 0);
        provider.shutdown().unwrap();
    }
}
