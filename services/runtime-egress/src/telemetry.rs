use std::{env, time::Duration};

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
}

#[derive(Clone, Debug)]
pub struct EgressMetrics {
    control_requests: Counter<u64>,
    control_duration_ms: Histogram<f64>,
    data_plane: DataPlaneInstruments,
}

#[derive(Clone, Debug)]
struct DataPlaneInstruments {
    uplink_packets: Gauge<u64>,
    uplink_bytes: Gauge<u64>,
    downlink_packets: Gauge<u64>,
    downlink_bytes: Gauge<u64>,
    policy_allows: Gauge<u64>,
    policy_denials: Gauge<u64>,
    malformed_packets: Gauge<u64>,
    unknown_agents: Gauge<u64>,
    fenced_packets: Gauge<u64>,
    active_flows: Gauge<u64>,
    flow_expirations: Gauge<u64>,
    flow_collisions: Gauge<u64>,
    flow_capacity_rejections: Gauge<u64>,
    reverse_flow_misses: Gauge<u64>,
    dns_accepted: Gauge<u64>,
    dns_rejected: Gauge<u64>,
    dns_completed: Gauge<u64>,
    dns_upstream_failures: Gauge<u64>,
    dns_client_bytes: Gauge<u64>,
    dns_upstream_bytes: Gauge<u64>,
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
        let tracer_provider = if !otlp_enabled {
            SdkTracerProvider::builder()
                .with_resource(service_resource())
                .build()
        } else {
            let endpoint = env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
                .or_else(|_| env::var("OTEL_EXPORTER_OTLP_ENDPOINT"))
                .unwrap_or_else(|_| "http://127.0.0.1:4318/v1/traces".to_owned());
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .with_endpoint(endpoint)
                .build()
                .map_err(|error| TelemetryError::Exporter(error.to_string()))?;
            SdkTracerProvider::builder()
                .with_batch_exporter(exporter)
                .with_resource(service_resource())
                .build()
        };
        let meter_provider = if !otlp_enabled {
            SdkMeterProvider::builder()
                .with_resource(service_resource())
                .build()
        } else {
            let endpoint = env::var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
                .or_else(|_| env::var("OTEL_EXPORTER_OTLP_ENDPOINT"))
                .unwrap_or_else(|_| "http://127.0.0.1:4318/v1/metrics".to_owned());
            let exporter = opentelemetry_otlp::MetricExporter::builder()
                .with_http()
                .with_endpoint(endpoint)
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
            "Runtime Egress telemetry initialized"
        );
        Ok(Self {
            tracer_provider: Some(tracer_provider),
            meter_provider: Some(meter_provider),
            metrics,
            otlp_enabled,
        })
    }

    pub fn metrics(&self) -> EgressMetrics {
        self.metrics.clone()
    }

    pub fn shutdown(mut self) {
        if let Some(provider) = self.meter_provider.take()
            && let Err(error) = provider.shutdown_with_timeout(Duration::from_secs(5))
        {
            tracing::error!(%error, "Runtime Egress metrics shutdown failed");
        }
        if let Some(provider) = self.tracer_provider.take()
            && let Err(error) = provider.shutdown_with_timeout(Duration::from_secs(5))
        {
            tracing::error!(%error, "Runtime Egress tracing shutdown failed");
        } else {
            tracing::info!(
                otlp_enabled = self.otlp_enabled,
                "Runtime Egress telemetry stopped"
            );
        }
    }
}

impl EgressMetrics {
    fn new(meter: Meter) -> Self {
        Self {
            control_requests: meter
                .u64_counter("antnest.egress.control.requests")
                .with_description("Completed Runtime Egress control requests")
                .build(),
            control_duration_ms: meter
                .f64_histogram("antnest.egress.control.duration")
                .with_description("Runtime Egress control request latency")
                .with_unit("ms")
                .build(),
            data_plane: DataPlaneInstruments::new(&meter),
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
            .dns_accepted
            .record(dns.accepted_connections, &[]);
        instruments
            .dns_rejected
            .record(dns.rejected_connections, &[]);
        instruments
            .dns_completed
            .record(dns.completed_connections, &[]);
        instruments
            .dns_upstream_failures
            .record(dns.upstream_failures, &[]);
        instruments
            .dns_client_bytes
            .record(dns.client_to_upstream_bytes, &[]);
        instruments
            .dns_upstream_bytes
            .record(dns.upstream_to_client_bytes, &[]);
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
            uplink_packets: gauge(meter, "antnest.egress.uplink.packets"),
            uplink_bytes: gauge(meter, "antnest.egress.uplink.bytes"),
            downlink_packets: gauge(meter, "antnest.egress.downlink.packets"),
            downlink_bytes: gauge(meter, "antnest.egress.downlink.bytes"),
            policy_allows: gauge(meter, "antnest.egress.policy.allows"),
            policy_denials: gauge(meter, "antnest.egress.policy.denials"),
            malformed_packets: gauge(meter, "antnest.egress.packet.malformed"),
            unknown_agents: gauge(meter, "antnest.egress.agent.unknown"),
            fenced_packets: gauge(meter, "antnest.egress.agent.fenced_packets"),
            active_flows: gauge(meter, "antnest.egress.flow.active"),
            flow_expirations: gauge(meter, "antnest.egress.flow.expirations"),
            flow_collisions: gauge(meter, "antnest.egress.flow.collisions"),
            flow_capacity_rejections: gauge(meter, "antnest.egress.flow.capacity_rejections"),
            reverse_flow_misses: gauge(meter, "antnest.egress.flow.reverse_misses"),
            dns_accepted: gauge(meter, "antnest.egress.dns.connections.accepted"),
            dns_rejected: gauge(meter, "antnest.egress.dns.connections.rejected"),
            dns_completed: gauge(meter, "antnest.egress.dns.connections.completed"),
            dns_upstream_failures: gauge(meter, "antnest.egress.dns.upstream.failures"),
            dns_client_bytes: gauge(meter, "antnest.egress.dns.client_to_upstream.bytes"),
            dns_upstream_bytes: gauge(meter, "antnest.egress.dns.upstream_to_client.bytes"),
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

fn service_resource() -> Resource {
    Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attributes([
            KeyValue::new("service.namespace", "antnest"),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        ])
        .build()
}

fn is_control_otlp_target(target: &str) -> bool {
    target == "antnest_runtime_egress::control"
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

    use super::{EgressMetrics, SERVICE_NAME, is_control_otlp_target, is_service_target};
    use crate::{dataplane::DataPlaneMetrics, dns::DnsMetricsSnapshot};

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
                active_flows: 1,
                ..DataPlaneMetrics::default()
            },
            DnsMetricsSnapshot {
                accepted_connections: 1,
                rejected_connections: 0,
                completed_connections: 1,
                upstream_failures: 0,
                client_to_upstream_bytes: 20,
                upstream_to_client_bytes: 40,
            },
        );
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
        assert!(names.contains(&"antnest.egress.dns.connections.accepted".to_owned()));
        provider.shutdown().unwrap();
    }
}
