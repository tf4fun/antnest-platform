use std::{
    env,
    io::{Error as IoError, ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use antnest_runtime_egress::telemetry::Telemetry;
use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::{KeyValue, any_value},
    metrics::v1::{metric, number_data_point},
};
use prost::Message as _;
use serde_json::Value;

const CHILD_ENV_VAR: &str = "ANTNEST_EGRESS_TELEMETRY_SHUTDOWN_CHILD";
const CHILD_SPAN_ENV_VAR: &str = "ANTNEST_EGRESS_TELEMETRY_CHILD_EMIT_SPAN";
const CHILD_TEST_NAME: &str = "telemetry_shutdown_child_fixture";
const CHILD_WATCHDOG: Duration = Duration::from_secs(15);
const QUIET_EXPORT_INTERVAL: &str = "3600000";
const UNSUPPORTED_EXPORTER_WARNING: &str =
    "OTEL_METRICS_EXPORTER is not supported; Runtime Egress metrics export disabled";

#[derive(Clone, Copy)]
enum ResponseKind {
    Ok,
    NotFound,
    Stall,
}

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    target: String,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct OtlpReceiver {
    endpoint: String,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    connections: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    accept: Option<thread::JoinHandle<()>>,
}

impl OtlpReceiver {
    fn start(responder: fn(&str) -> ResponseKind) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind OTLP receiver");
        listener
            .set_nonblocking(true)
            .expect("nonblocking OTLP listener");
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(Mutex::new(Vec::new()));
        let accept = {
            let stop = Arc::clone(&stop);
            let requests = Arc::clone(&requests);
            let connections = Arc::clone(&connections);
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let requests = Arc::clone(&requests);
                            let stop = Arc::clone(&stop);
                            let handle = thread::spawn(move || {
                                serve_connection(stream, responder, requests, stop);
                            });
                            connections.lock().unwrap().push(handle);
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            })
        };
        Self {
            endpoint,
            stop,
            requests,
            connections,
            accept: Some(accept),
        }
    }

    fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn requests_to(&self, needle: &str) -> Vec<RecordedRequest> {
        self.requests()
            .into_iter()
            .filter(|request| request.target.contains(needle))
            .collect()
    }

    fn metrics_requests(&self) -> Vec<RecordedRequest> {
        self.requests_to("metrics")
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(accept) = self.accept.take()
            && let Err(error) = accept.join()
        {
            eprintln!("OTLP receiver accept thread panicked: {error:?}");
        }
        let handles = std::mem::take(&mut *self.connections.lock().unwrap());
        for handle in handles {
            if let Err(error) = handle.join() {
                eprintln!("OTLP receiver worker panicked: {error:?}");
            }
        }
    }
}

impl Drop for OtlpReceiver {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn serve_connection(
    mut stream: TcpStream,
    responder: fn(&str) -> ResponseKind,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    stop: Arc<AtomicBool>,
) {
    if stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .is_err()
    {
        return;
    }
    let Ok(request) = read_request(&mut stream) else {
        return;
    };
    let response = responder(&request.target);
    requests.lock().unwrap().push(request);
    match response {
        ResponseKind::Ok => {
            respond(&mut stream, "200 OK", Some("application/x-protobuf"));
        }
        ResponseKind::NotFound => {
            respond(&mut stream, "404 Not Found", None);
        }
        ResponseKind::Stall => {
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<RecordedRequest, IoError> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > 64 * 1024 {
            return Err(IoError::new(ErrorKind::InvalidData, "headers too large"));
        }
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(IoError::new(ErrorKind::UnexpectedEof, "connection closed"));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = head.lines();
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_owned();
    let target = request_line.next().unwrap_or_default().to_owned();
    let mut content_type = None;
    let mut content_length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "content-type" => content_type = Some(value.to_owned()),
                "content-length" => content_length = value.parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    while buffer.len() < header_end + content_length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let end = buffer.len().min(header_end + content_length);
    Ok(RecordedRequest {
        method,
        target,
        content_type,
        body: buffer[header_end..end].to_vec(),
    })
}

fn respond(stream: &mut TcpStream, status: &str, content_type: Option<&str>) {
    let mut head = format!("HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: 0\r\n");
    if let Some(content_type) = content_type {
        head.push_str(&format!("content-type: {content_type}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.flush();
}

struct ChildOutput {
    code: Option<i32>,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

impl ChildOutput {
    fn json_logs(&self) -> Vec<Value> {
        self.stdout
            .lines()
            .filter(|line| line.starts_with('{') && line.ends_with('}'))
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn shutdown_elapsed_ms(&self) -> Option<u64> {
        self.stderr.lines().find_map(|line| {
            line.strip_prefix("CHILD_SHUTDOWN_ELAPSED_MS=")
                .and_then(|value| value.parse().ok())
        })
    }

    fn application_succeeded(&self) -> bool {
        self.code == Some(0)
            && self
                .stderr
                .lines()
                .any(|line| line == "CHILD_APPLICATION_RESULT=success")
    }
}

fn run_child(vars: &[(&str, &str)]) -> ChildOutput {
    let mut command = Command::new(env::current_exe().expect("current test binary"));
    command
        .arg(CHILD_TEST_NAME)
        .arg("--exact")
        .arg("--nocapture")
        .env(CHILD_ENV_VAR, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, _) in env::vars() {
        if key.starts_with("OTEL_") || key == "RUST_LOG" {
            command.env_remove(key);
        }
    }
    for (key, value) in vars {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn telemetry child");
    let mut stdout = child.stdout.take().expect("child stdout pipe");
    let mut stderr = child.stderr.take().expect("child stderr pipe");
    let stdout_thread = thread::spawn(move || {
        let mut captured = String::new();
        let _ = stdout.read_to_string(&mut captured);
        captured
    });
    let stderr_thread = thread::spawn(move || {
        let mut captured = String::new();
        let _ = stderr.read_to_string(&mut captured);
        captured
    });
    let deadline = Instant::now() + CHILD_WATCHDOG;
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let status = child.wait().expect("reap killed telemetry child");
                break (status.code(), true);
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => panic!("polling telemetry child failed: {error}"),
        }
    };
    ChildOutput {
        code,
        timed_out,
        stdout: stdout_thread.join().expect("join child stdout reader"),
        stderr: stderr_thread.join().expect("join child stderr reader"),
    }
}

fn assert_child_success(output: &ChildOutput) {
    assert!(
        !output.timed_out,
        "telemetry child exceeded the watchdog and was killed; stderr: {}",
        output.stderr
    );
    assert!(
        output.application_succeeded(),
        "telemetry child did not report application success (code {:?})\nstdout: {}\nstderr: {}",
        output.code,
        output.stdout,
        output.stderr
    );
}

fn find_log<'a>(logs: &'a [Value], message: &str) -> Option<&'a Value> {
    logs.iter()
        .find(|log| json_field(log, "message") == Some(message))
}

fn json_field<'a>(log: &'a Value, key: &str) -> Option<&'a str> {
    log.get(key)?.as_str()
}

fn shutdown_summary(logs: &[Value]) -> &Value {
    find_log(logs, "Runtime Egress telemetry stopped")
        .or_else(|| {
            find_log(
                logs,
                "Runtime Egress telemetry stopped with export failures",
            )
        })
        .expect("missing telemetry shutdown summary")
}

fn assert_metrics_disabled_summary(logs: &[Value]) {
    let summary = find_log(logs, "Runtime Egress telemetry stopped")
        .expect("missing telemetry shutdown summary");
    assert_eq!(
        json_field(summary, "metrics_status"),
        Some("disabled"),
        "shutdown summary should report disabled metrics: {summary}"
    );
    assert_eq!(
        json_field(summary, "tracing_status"),
        Some("stopped"),
        "shutdown summary should report stopped tracing: {summary}"
    );
    assert_eq!(
        json_field(summary, "export_delivery"),
        Some("unverified"),
        "shutdown summary must not claim verified export delivery: {summary}"
    );
}

fn attribute_value(attributes: &[KeyValue], wanted: &str) -> Option<String> {
    attributes
        .iter()
        .find(|attribute| attribute.key == wanted)
        .and_then(|attribute| attribute.value.as_ref())
        .and_then(|value| match value.value.as_ref()? {
            any_value::Value::StringValue(text) => Some(text.clone()),
            any_value::Value::IntValue(number) => Some(number.to_string()),
            any_value::Value::DoubleValue(number) => Some(number.to_string()),
            any_value::Value::BoolValue(flag) => Some(flag.to_string()),
            _ => None,
        })
}

fn assert_no_metrics_export(output: &ChildOutput, observed: &[RecordedRequest]) {
    assert_child_success(output);
    assert!(
        observed
            .iter()
            .all(|request| !request.target.contains("metrics")),
        "disabled metrics export still reached the receiver: {:?}",
        observed
            .iter()
            .map(|request| request.target.as_str())
            .collect::<Vec<_>>()
    );
    let logs = output.json_logs();
    assert!(
        find_log(&logs, "Runtime Egress metrics shutdown failed").is_none(),
        "metrics shutdown failure was reported while metrics were disabled: {logs:?}"
    );
    assert_metrics_disabled_summary(&logs);
}

#[test]
fn metrics_exporter_none_disables_metrics_export() {
    let mut receiver = OtlpReceiver::start(|_| ResponseKind::Ok);
    let endpoint = receiver.endpoint().to_owned();
    let output = run_child(&[
        ("OTEL_SDK_DISABLED", "false"),
        ("OTEL_METRICS_EXPORTER", "none"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
        ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
    ]);
    let observed = receiver.metrics_requests();
    receiver.shutdown();
    assert_no_metrics_export(&output, &observed);
}

#[test]
fn missing_or_empty_metrics_exporter_disables_export_by_default() {
    let mut receiver = OtlpReceiver::start(|_| ResponseKind::Ok);
    let endpoint = receiver.endpoint().to_owned();
    for metrics_exporter in [None, Some("")] {
        let before = receiver.requests().len();
        let mut vars = vec![
            ("OTEL_SDK_DISABLED", "false"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
            ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
        ];
        if let Some(exporter) = metrics_exporter {
            vars.push(("OTEL_METRICS_EXPORTER", exporter));
        }
        let output = run_child(&vars);
        let observed = receiver.requests()[before..]
            .iter()
            .filter(|request| request.target.contains("metrics"))
            .cloned()
            .collect::<Vec<_>>();
        assert_no_metrics_export(&output, &observed);
    }
    receiver.shutdown();
}

#[test]
fn unsupported_metrics_exporter_disables_export_with_stable_warning() {
    let mut receiver = OtlpReceiver::start(|_| ResponseKind::Ok);
    let endpoint = receiver.endpoint().to_owned();
    let output = run_child(&[
        ("OTEL_SDK_DISABLED", "false"),
        ("OTEL_METRICS_EXPORTER", "grpc"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
        ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
    ]);
    let observed = receiver.metrics_requests();
    receiver.shutdown();
    assert_no_metrics_export(&output, &observed);
    let logs = output.json_logs();
    assert!(
        find_log(&logs, UNSUPPORTED_EXPORTER_WARNING).is_some(),
        "missing stable unsupported-exporter warning: {logs:?}"
    );
    assert!(
        !logs.iter().any(|log| log.to_string().contains("grpc")),
        "unsupported exporter warning leaked the raw configured value"
    );
}

#[test]
fn sdk_disabled_suppresses_metrics_export() {
    let mut receiver = OtlpReceiver::start(|_| ResponseKind::Ok);
    let endpoint = receiver.endpoint().to_owned();
    let output = run_child(&[
        ("OTEL_SDK_DISABLED", "true"),
        ("OTEL_METRICS_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
        ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
    ]);
    receiver.shutdown();
    assert_child_success(&output);
    assert!(
        receiver.metrics_requests().is_empty(),
        "disabled SDK still exported metrics: {:?}",
        receiver.requests()
    );
    let logs = output.json_logs();
    let summary = find_log(&logs, "Runtime Egress telemetry stopped")
        .expect("missing telemetry shutdown summary");
    assert_eq!(
        json_field(summary, "metrics_status"),
        Some("disabled"),
        "shutdown summary should report disabled metrics: {summary}"
    );
    assert_eq!(
        json_field(summary, "tracing_status"),
        Some("disabled"),
        "shutdown summary should report disabled tracing: {summary}"
    );
    assert_eq!(
        json_field(summary, "export_delivery"),
        Some("unverified"),
        "shutdown summary must not claim verified export delivery: {summary}"
    );
}

#[test]
fn enabled_metrics_exporter_flushes_pending_metrics_on_shutdown() {
    let mut receiver = OtlpReceiver::start(|_| ResponseKind::Ok);
    let endpoint = receiver.endpoint().to_owned();
    let metrics_endpoint = format!("{endpoint}/metrics-final");
    let output = run_child(&[
        ("OTEL_SDK_DISABLED", "false"),
        ("OTEL_METRICS_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
        (
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            metrics_endpoint.as_str(),
        ),
        ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
    ]);
    let exports = receiver.metrics_requests();
    receiver.shutdown();
    assert_child_success(&output);
    assert!(
        output
            .shutdown_elapsed_ms()
            .is_some_and(|elapsed| elapsed < 5_000),
        "telemetry shutdown took too long: {:?}ms",
        output.shutdown_elapsed_ms()
    );
    assert_eq!(
        exports.len(),
        1,
        "expected a single shutdown metrics export, saw: {:?}",
        exports
            .iter()
            .map(|request| request.target.as_str())
            .collect::<Vec<_>>()
    );
    let export = &exports[0];
    assert_eq!(export.method, "POST");
    assert_eq!(export.target, "/metrics-final");
    assert!(
        export
            .content_type
            .as_deref()
            .is_some_and(|value| value.contains("x-protobuf")),
        "unexpected metrics export content type: {:?}",
        export.content_type
    );
    let request = ExportMetricsServiceRequest::decode(export.body.as_slice())
        .expect("metrics export body did not decode");
    assert_eq!(request.resource_metrics.len(), 1);
    let resource_metrics = &request.resource_metrics[0];
    let resource_attributes = resource_metrics
        .resource
        .as_ref()
        .map(|resource| resource.attributes.clone())
        .unwrap_or_default();
    assert_eq!(
        attribute_value(&resource_attributes, "service.name").as_deref(),
        Some("antnest-runtime-egress")
    );
    let counter = resource_metrics
        .scope_metrics
        .iter()
        .flat_map(|scope| scope.metrics.iter())
        .find(|metric| metric.name == "antnest.egress.control.requests")
        .expect("antnest.egress.control.requests missing from shutdown export");
    let Some(metric::Data::Sum(sum)) = &counter.data else {
        panic!("antnest.egress.control.requests was not exported as a sum");
    };
    assert_eq!(sum.data_points.len(), 1);
    let point = &sum.data_points[0];
    assert!(
        matches!(point.value, Some(number_data_point::Value::AsInt(1))),
        "expected control request counter value 1, got {:?}",
        point.value
    );
    let mut keys = point
        .attributes
        .iter()
        .map(|attribute| attribute.key.clone())
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "http.request.method",
            "http.response.status_code",
            "http.route",
            "outcome"
        ]
    );
    assert_eq!(
        attribute_value(&point.attributes, "http.request.method").as_deref(),
        Some("GET")
    );
    assert_eq!(
        attribute_value(&point.attributes, "http.route").as_deref(),
        Some("/status")
    );
    assert_eq!(
        attribute_value(&point.attributes, "http.response.status_code").as_deref(),
        Some("200")
    );
    assert_eq!(
        attribute_value(&point.attributes, "outcome").as_deref(),
        Some("success")
    );
    let logs = output.json_logs();
    let summary = find_log(&logs, "Runtime Egress telemetry stopped")
        .expect("missing telemetry shutdown summary");
    assert_eq!(
        json_field(summary, "metrics_status"),
        Some("stopped"),
        "shutdown summary should report stopped metrics: {summary}"
    );
    assert_eq!(
        json_field(summary, "tracing_status"),
        Some("stopped"),
        "shutdown summary should report stopped tracing: {summary}"
    );
    assert_eq!(
        json_field(summary, "export_delivery"),
        Some("unverified"),
        "shutdown summary must not claim verified export delivery: {summary}"
    );
}

#[test]
fn failed_metrics_export_is_reported_in_shutdown_summary() {
    let mut receiver = OtlpReceiver::start(|target| {
        if target.contains("metrics") {
            ResponseKind::NotFound
        } else {
            ResponseKind::Ok
        }
    });
    let endpoint = receiver.endpoint().to_owned();
    let output = run_child(&[
        ("OTEL_SDK_DISABLED", "false"),
        ("OTEL_METRICS_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
        ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
        (CHILD_SPAN_ENV_VAR, "1"),
    ]);
    receiver.shutdown();
    assert_child_success(&output);
    assert!(
        !receiver.metrics_requests().is_empty(),
        "expected the failed metrics export to reach the receiver"
    );
    assert!(
        !receiver.requests_to("traces").is_empty(),
        "expected the trace export to be attempted after the metrics failure"
    );
    let logs = output.json_logs();
    let failure = find_log(&logs, "Runtime Egress metrics shutdown failed")
        .expect("expected a metrics shutdown failure to be logged");
    let error = json_field(failure, "error").unwrap_or_default();
    assert!(
        error.contains("Failed to shutdown"),
        "unexpected metrics shutdown error: {error}"
    );
    assert!(
        find_log(&logs, "Runtime Egress telemetry stopped").is_none(),
        "telemetry reported a clean stop despite the failed metrics export: {logs:?}"
    );
    let summary = find_log(
        &logs,
        "Runtime Egress telemetry stopped with export failures",
    )
    .expect("missing failed-export shutdown summary");
    assert_eq!(
        json_field(summary, "metrics_status"),
        Some("failed"),
        "shutdown summary should report failed metrics: {summary}"
    );
    assert_eq!(
        json_field(summary, "tracing_status"),
        Some("stopped"),
        "shutdown summary should report stopped tracing: {summary}"
    );
    assert_eq!(
        json_field(summary, "export_delivery"),
        Some("unverified"),
        "shutdown summary must not claim verified export delivery: {summary}"
    );
}

#[test]
fn stalled_metrics_export_is_bounded_during_shutdown() {
    let mut receiver = OtlpReceiver::start(|_| ResponseKind::Stall);
    let endpoint = receiver.endpoint().to_owned();
    let output = run_child(&[
        ("OTEL_SDK_DISABLED", "false"),
        ("OTEL_METRICS_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
        ("OTEL_METRIC_EXPORT_INTERVAL", QUIET_EXPORT_INTERVAL),
    ]);
    receiver.shutdown();
    assert_child_success(&output);
    let elapsed = output
        .shutdown_elapsed_ms()
        .expect("telemetry child did not report shutdown elapsed time");
    assert!(
        elapsed < 5_000,
        "telemetry shutdown blocked {elapsed}ms on a stalled metrics export"
    );
    assert!(
        !receiver.metrics_requests().is_empty(),
        "expected the stalled metrics export to reach the receiver"
    );
    let logs = output.json_logs();
    let failure = find_log(&logs, "Runtime Egress metrics shutdown failed")
        .expect("expected a metrics shutdown failure to be logged");
    let error = json_field(failure, "error").unwrap_or_default();
    assert!(
        error.contains("shutdown") || error.contains("timed out"),
        "unexpected metrics shutdown error: {error}"
    );
    let summary = shutdown_summary(&logs);
    assert_eq!(
        json_field(summary, "metrics_status"),
        Some("failed"),
        "shutdown summary should report failed metrics: {summary}"
    );
    assert_eq!(
        json_field(summary, "export_delivery"),
        Some("unverified"),
        "shutdown summary must not claim verified export delivery: {summary}"
    );
}

#[test]
fn telemetry_shutdown_child_fixture() {
    if env::var_os(CHILD_ENV_VAR).is_none() {
        return;
    }
    let telemetry = Telemetry::init().expect("telemetry init failed");
    if env::var_os(CHILD_SPAN_ENV_VAR).is_some() {
        let span = tracing::info_span!(target: "antnest_runtime_egress::control", "control.probe");
        span.in_scope(|| {});
    }
    telemetry.metrics().control(
        "GET",
        "/status",
        200,
        "success",
        "",
        Duration::from_millis(1),
    );
    let started = Instant::now();
    telemetry.shutdown();
    eprintln!(
        "CHILD_SHUTDOWN_ELAPSED_MS={}",
        started.elapsed().as_millis()
    );
    eprintln!("CHILD_APPLICATION_RESULT=success");
}
