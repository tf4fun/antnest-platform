#![cfg_attr(not(target_os = "linux"), allow(dead_code, unused_imports))]
#![allow(clippy::large_enum_variant)]

mod command;
mod config;
mod evidence;
mod execution;
mod execution_actor;
mod executor;
mod executor_protocol;
mod information;
mod lifecycle_error;
mod managed_mcp;
mod mcp;
mod network;
#[cfg(target_os = "linux")]
mod network_session;
mod packet;
mod privilege;
mod processes;
mod protocol;
mod roots;
mod spec;
#[cfg(target_os = "linux")]
mod startup;
mod telemetry;
mod tool_error;
mod tools;

use lifecycle_error::{BootstrapErrorCode, BootstrapStage, RuntimeErrorCode};

#[cfg(test)]
mod information_tests;
#[cfg(test)]
mod managed_mcp_tests;
#[cfg(test)]
mod mcp_contract_tests;
#[cfg(test)]
mod runtime_process_contract_tests;
#[cfg(test)]
mod spec_contract_tests;

fn main() {
    let command = match command::Command::parse(std::env::args_os().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(64);
        }
    };
    match command {
        command::Command::Serve => report_server_exit(run()),
        command::Command::McpStdio => {
            if let Err(error) = managed_mcp::entry::run() {
                eprintln!("{error}");
                std::process::exit(70);
            }
        }
        command::Command::Tool(tool) => {
            if let Err(error) = executor::run(tool) {
                eprintln!("{error}");
                std::process::exit(70);
            }
        }
    }
}

fn report_server_exit(result: Result<(), ExitError>) {
    if let Err(error) = result {
        let (phase, stage, component, error_type, reason, identity) = match &error {
            ExitError::Bootstrap(failure) => (
                "bootstrap",
                Some(failure.stage.as_str()),
                "runtime.bootstrap",
                failure.error_type.as_str(),
                failure.source.to_string(),
                failure.identity.as_ref(),
            ),
            ExitError::Runtime(failure) => (
                "runtime",
                None,
                failure.component,
                failure.error_type.as_str(),
                failure.message.clone(),
                Some(&failure.identity),
            ),
        };
        eprintln!(
            "{}",
            serde_json::json!({
                "level": "ERROR",
                "service.name": telemetry::SERVICE_NAME,
                "lifecycle.event": "process_exit",
                "exit_code": 78,
                "phase": phase,
                "bootstrap.stage": stage,
                "component": component,
                "error.type": error_type,
                "reason": reason,
                "antnest.agent.id": identity.map(spec::RuntimeIdentity::agent_id),
                "antnest.runtime.generation": identity.map(|value| value.generation().to_string()),
                "trace_id": "",
                "span_id": "",
            })
        );
        std::process::exit(78);
    }
}

type BoxError = Box<dyn std::error::Error>;

enum ExitError {
    Bootstrap(BootstrapFailure),
    Runtime(RuntimeFailure),
}

#[derive(Debug)]
struct BootstrapFailure {
    stage: BootstrapStage,
    error_type: BootstrapErrorCode,
    identity: Option<spec::RuntimeIdentity>,
    source: BoxError,
}

#[derive(Debug)]
struct RuntimeFailure {
    identity: spec::RuntimeIdentity,
    component: &'static str,
    error_type: RuntimeErrorCode,
    message: String,
}

impl std::fmt::Display for RuntimeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} failed with {}: {}",
            self.component, self.error_type, self.message
        )
    }
}

impl std::error::Error for RuntimeFailure {}

#[derive(Debug)]
struct ServiceFailure {
    component: &'static str,
    error_type: RuntimeErrorCode,
    message: String,
}

#[cfg(target_os = "linux")]
enum RuntimeExit {
    Http(Result<(), std::io::Error>),
    Network(Result<(), network_session::NetworkSessionError>),
    Reaper(Result<(), std::io::Error>),
    Managed(managed_mcp::manager::ManagedError),
    Execution,
    Shutdown,
}

#[cfg(target_os = "linux")]
impl RuntimeExit {
    fn normalize(self, shutdown_requested: bool) -> Self {
        match self {
            Self::Http(Ok(())) | Self::Network(Ok(())) | Self::Reaper(Ok(()))
                if shutdown_requested =>
            {
                Self::Shutdown
            }
            exit => exit,
        }
    }
}

#[cfg(target_os = "linux")]
struct PreparedRuntime {
    spec: spec::RuntimeSpec,
    network: network::RuntimeNetwork,
    telemetry: telemetry::TelemetryConfig,
    executor: tokio::runtime::Runtime,
}

#[cfg(target_os = "linux")]
fn run() -> Result<(), ExitError> {
    let PreparedRuntime {
        spec,
        network,
        telemetry,
        executor,
    } = bootstrap().map_err(ExitError::Bootstrap)?;
    executor
        .block_on(run_runtime(spec, network, telemetry))
        .map_err(ExitError::Runtime)
}

#[cfg(target_os = "linux")]
fn bootstrap() -> Result<PreparedRuntime, BootstrapFailure> {
    use std::env;
    use std::fs;

    use evidence::EvidenceBuilder;
    use nix::unistd::{Gid, Uid, chown};

    let mut evidence = EvidenceBuilder::default();
    evidence.push(
        BootstrapStage::Entry,
        privilege::harden_entry().map_err(|error| {
            bootstrap_failure(
                BootstrapStage::Entry,
                BootstrapErrorCode::EntryFailed,
                None,
                error,
            )
        })?,
    );
    report_bootstrap_stage(BootstrapStage::Entry, None);

    let spec = config::load().map_err(|error| {
        bootstrap_failure(
            BootstrapStage::RuntimeSpec,
            BootstrapErrorCode::InvalidConfig,
            None,
            error,
        )
    })?;
    let identity = spec.identity().clone();
    report_bootstrap_stage(BootstrapStage::RuntimeSpec, Some(&identity));
    let telemetry = config::load_telemetry();
    unsafe {
        env::set_var("HOME", spec.filesystem().workspace());
        env::set_var(
            "XDG_CACHE_HOME",
            spec.filesystem().workspace().join(".cache"),
        );
        env::set_var(
            "XDG_CONFIG_HOME",
            spec.filesystem().workspace().join(".config"),
        );
        env::set_var(
            "XDG_DATA_HOME",
            spec.filesystem().workspace().join(".local/share"),
        );
        env::set_var("PATH", "/usr/local/bin:/usr/bin:/bin");
    }
    evidence.push(
        BootstrapStage::EnvironmentSanitized,
        privilege::snapshot().map_err(|error| {
            bootstrap_failure(
                BootstrapStage::EnvironmentSanitized,
                BootstrapErrorCode::EnvironmentVerificationFailed,
                Some(identity.clone()),
                error,
            )
        })?,
    );
    report_bootstrap_stage(BootstrapStage::EnvironmentSanitized, Some(&identity));

    let network = network::RuntimeNetwork::bootstrap(spec.network(), spec.listen().port())
        .map_err(|error| {
            bootstrap_failure(
                BootstrapStage::NetworkReady,
                BootstrapErrorCode::NetworkBootstrapFailed,
                Some(identity.clone()),
                error,
            )
        })?;
    evidence.push(
        BootstrapStage::NetworkReady,
        privilege::snapshot().map_err(|error| {
            bootstrap_failure(
                BootstrapStage::NetworkReady,
                BootstrapErrorCode::NetworkVerificationFailed,
                Some(identity.clone()),
                error,
            )
        })?,
    );
    report_bootstrap_stage(BootstrapStage::NetworkReady, Some(&identity));
    for path in [
        spec.filesystem().workspace().join(".antnest"),
        spec.filesystem().workspace().join(".antnest/skills"),
        spec.filesystem().workspace().join(".cache"),
        spec.filesystem().workspace().join(".config"),
        spec.filesystem().workspace().join(".local"),
        spec.filesystem().workspace().join(".local/share"),
    ] {
        fs::create_dir_all(&path).map_err(|error| {
            bootstrap_failure(
                BootstrapStage::Filesystem,
                BootstrapErrorCode::WorkspaceInitializationFailed,
                Some(identity.clone()),
                error,
            )
        })?;
        chown(&path, Some(Uid::from_raw(1000)), Some(Gid::from_raw(1000))).map_err(|error| {
            bootstrap_failure(
                BootstrapStage::Filesystem,
                BootstrapErrorCode::WorkspaceOwnershipFailed,
                Some(identity.clone()),
                std::io::Error::from_raw_os_error(error as i32),
            )
        })?;
    }
    report_bootstrap_stage(BootstrapStage::Filesystem, Some(&identity));
    roots::NamedRoots::open(
        spec.filesystem().workspace(),
        spec.filesystem().system_skills(),
    )
    .map_err(|error| {
        bootstrap_failure(
            BootstrapStage::Filesystem,
            BootstrapErrorCode::NamedRootsFailed,
            Some(identity.clone()),
            error,
        )
    })?;
    evidence.push(
        BootstrapStage::RootsReady,
        privilege::snapshot().map_err(|error| {
            bootstrap_failure(
                BootstrapStage::RootsReady,
                BootstrapErrorCode::RootVerificationFailed,
                Some(identity.clone()),
                error,
            )
        })?,
    );
    report_bootstrap_stage(BootstrapStage::RootsReady, Some(&identity));
    evidence.push(
        BootstrapStage::PreTokio,
        privilege::snapshot().map_err(|error| {
            bootstrap_failure(
                BootstrapStage::PreTokio,
                BootstrapErrorCode::PreExecutorVerificationFailed,
                Some(identity.clone()),
                error,
            )
        })?,
    );
    evidence.finish().map_err(|error| {
        bootstrap_failure(
            BootstrapStage::PreTokio,
            BootstrapErrorCode::BootstrapEvidenceFailed,
            Some(identity.clone()),
            std::io::Error::other(error),
        )
    })?;
    report_bootstrap_stage(BootstrapStage::PreTokio, Some(&identity));

    let executor = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("antnest-runtime")
        .build()
        .map_err(|error| {
            bootstrap_failure(
                BootstrapStage::Executor,
                BootstrapErrorCode::ExecutorInitializationFailed,
                Some(identity.clone()),
                error,
            )
        })?;
    report_bootstrap_stage(BootstrapStage::Executor, Some(&identity));
    Ok(PreparedRuntime {
        spec,
        network,
        telemetry,
        executor,
    })
}

fn report_bootstrap_stage(stage: BootstrapStage, identity: Option<&spec::RuntimeIdentity>) {
    eprintln!("{}", bootstrap_stage_event(stage, identity));
}

fn bootstrap_stage_event(
    stage: BootstrapStage,
    identity: Option<&spec::RuntimeIdentity>,
) -> serde_json::Value {
    serde_json::json!({
        "level": "INFO",
        "service.name": telemetry::SERVICE_NAME,
        "lifecycle.event": "bootstrap_stage_completed",
        "bootstrap.stage": stage.as_str(),
        "antnest.agent.id": identity.map(spec::RuntimeIdentity::agent_id),
        "antnest.runtime.generation": identity.map(|value| value.generation().to_string()),
        "trace_id": "",
        "span_id": "",
    })
}

fn bootstrap_failure(
    stage: BootstrapStage,
    error_type: BootstrapErrorCode,
    identity: Option<spec::RuntimeIdentity>,
    source: impl std::error::Error + 'static,
) -> BootstrapFailure {
    BootstrapFailure {
        stage,
        error_type,
        identity,
        source: Box::new(source),
    }
}

#[cfg(target_os = "linux")]
async fn run_runtime(
    spec: spec::RuntimeSpec,
    network: network::RuntimeNetwork,
    telemetry_config: telemetry::TelemetryConfig,
) -> Result<(), RuntimeFailure> {
    use tracing::Instrument as _;

    let telemetry = telemetry::Telemetry::init(
        spec.identity(),
        network.platform_network(),
        &telemetry_config,
    )
    .map_err(|error| {
        runtime_failure(
            spec.identity().clone(),
            "telemetry",
            RuntimeErrorCode::TelemetryInitializationFailed,
            error,
        )
    })?;
    let process_span = tracing::info_span!(
        "runtime.process",
        "service.name" = telemetry::SERVICE_NAME,
        "antnest.agent.id" = spec.identity().agent_id(),
        "antnest.runtime.generation" = %spec.identity().generation(),
        otel.status_code = tracing::field::Empty,
        error.type = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        span_id = tracing::field::Empty,
    );
    telemetry::record_span_identity(&process_span);
    let identity = spec.identity().clone();
    let result = supervise_runtime(spec, network, telemetry.metrics())
        .instrument(process_span.clone())
        .await;
    if let Err(error) = &result {
        process_span.record("otel.status_code", "ERROR");
        process_span.record("error.type", error.error_type.as_str());
    }
    process_span.in_scope(|| {
        tracing::info!(
            "service.name" = telemetry::SERVICE_NAME,
            "antnest.agent.id" = identity.agent_id(),
            "antnest.runtime.generation" = %identity.generation(),
            outcome = if result.is_ok() { "success" } else { "error" },
            "Runtime service stopped"
        );
    });
    drop(process_span);
    telemetry.shutdown();
    result
}

#[cfg(target_os = "linux")]
async fn supervise_runtime(
    spec: spec::RuntimeSpec,
    network: network::RuntimeNetwork,
    metrics: telemetry::RuntimeMetrics,
) -> Result<(), RuntimeFailure> {
    use tokio::signal::unix::{SignalKind, signal};
    use tokio_util::sync::CancellationToken;

    let agent_id = spec.identity().agent_id().to_owned();
    let generation = spec.identity().generation();
    let identity = spec.identity().clone();
    let shutdown = CancellationToken::new();
    let mut terminate = signal(SignalKind::terminate()).map_err(|error| {
        runtime_failure(
            identity.clone(),
            "signal",
            RuntimeErrorCode::SignalListenerFailed,
            error,
        )
    })?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| {
        runtime_failure(
            identity,
            "signal",
            RuntimeErrorCode::SignalListenerFailed,
            error,
        )
    })?;
    let mut running = Box::pin(serve_runtime(spec, network, metrics, shutdown.clone()));
    let result = tokio::select! {
        result = &mut running => result,
        _ = terminate.recv() => {
            log_shutdown("SIGTERM", &agent_id, generation);
            shutdown.cancel();
            running.await
        }
        _ = interrupt.recv() => {
            log_shutdown("SIGINT", &agent_id, generation);
            shutdown.cancel();
            running.await
        }
    };
    if let Err(error) = &result {
        tracing::error!(
            component = error.component,
            error.type = error.error_type.as_str(),
            reason = error.message,
            "antnest.agent.id" = agent_id,
            "antnest.runtime.generation" = %generation,
            "Runtime stopped after a fatal error"
        );
    }
    result
}

#[cfg(target_os = "linux")]
async fn serve_runtime(
    spec: spec::RuntimeSpec,
    network: network::RuntimeNetwork,
    metrics: telemetry::RuntimeMetrics,
    shutdown: tokio_util::sync::CancellationToken,
) -> Result<(), RuntimeFailure> {
    use std::time::Duration;

    let identity = spec.identity().clone();
    let network_session =
        network_session::NetworkSession::prepare(network, spec.identity().generation())
            .await
            .map_err(|error| runtime_failure(identity.clone(), "network", error.code(), error))?;
    tracing::info!(
        lifecycle.event = "egress_path_verified",
        "antnest.agent.id" = spec.identity().agent_id(),
        "antnest.runtime.generation" = %spec.identity().generation(),
        "Runtime Egress packet path verified"
    );
    let service_shutdown = shutdown.child_token();
    let (actor, mut execution_failures) = execution_actor::ExecutionActor::new(
        identity.clone(),
        spec.filesystem().workspace().to_owned(),
        spec.filesystem().system_skills().to_owned(),
        metrics.clone(),
        service_shutdown.clone(),
    );
    actor.probe().await.map_err(|error| {
        runtime_failure(
            identity.clone(),
            "executor",
            RuntimeErrorCode::ExecutorProbeFailed,
            error.message,
        )
    })?;
    let mut network_task =
        Box::pin(network_session.run(service_shutdown.clone(), identity.clone(), metrics.clone()));
    let Some(mut managed) = startup::initialize_managed(
        &spec,
        &actor.children(),
        &mut network_task,
        &service_shutdown,
    )
    .await
    .map_err(|failure| runtime_failure_from_service(identity.clone(), failure))?
    else {
        return Ok(());
    };
    let listener = match tokio::net::TcpListener::bind(spec.listen()).await {
        Ok(listener) => listener,
        Err(error) => {
            if let Err(cleanup) = managed.shutdown().await {
                tracing::error!(error.type = cleanup.code.as_str(), "Managed MCP cleanup after HTTP bind failure failed");
            }
            return Err(runtime_failure(
                identity.clone(),
                "http",
                RuntimeErrorCode::HttpBindFailed,
                error,
            ));
        }
    };
    let status = mcp::RuntimeStatus::new(spec.identity().clone());
    let http = mcp::RuntimeHttp::new(status, actor.clone(), metrics.clone(), managed.catalog());
    tracing::info!(
        listen = %spec.listen(),
        "antnest.agent.id" = spec.identity().agent_id(),
        "antnest.runtime.generation" = %spec.identity().generation(),
        "Runtime is ready"
    );

    let mut http_task = Box::pin(http.serve(listener, service_shutdown.clone()));
    let children = actor.children();
    let mut reaper = Box::pin(children.reap_orphans(service_shutdown.clone()));
    let exit = tokio::select! {
        result = &mut http_task => RuntimeExit::Http(result),
        result = &mut network_task => RuntimeExit::Network(result),
        result = &mut reaper => RuntimeExit::Reaper(result),
        error = managed.wait_failure() => RuntimeExit::Managed(error),
        _ = execution_failures.recv() => RuntimeExit::Execution,
        _ = shutdown.cancelled() => RuntimeExit::Shutdown,
    };
    let wait_http = !matches!(&exit, RuntimeExit::Http(_));
    let wait_network = !matches!(&exit, RuntimeExit::Network(_));
    let exit = exit.normalize(shutdown.is_cancelled());
    actor.close();
    service_shutdown.cancel();
    const STOP_TIMEOUT: Duration = Duration::from_secs(8);
    let (mut stop_failures, managed_stop) = tokio::join!(
        stop_runtime_services(
            wait_http,
            wait_network,
            &mut http_task,
            &mut network_task,
            &actor,
            STOP_TIMEOUT,
        ),
        managed.shutdown()
    );
    if let Err(error) = managed_stop {
        stop_failures.push(ServiceFailure {
            component: "managed_mcp",
            error_type: error.code,
            message: error.to_string(),
        });
    }
    match exit {
        RuntimeExit::Http(result) => {
            let primary = http_exit_failure(result);
            log_secondary_failures(&identity, &primary, stop_failures);
            Err(runtime_failure_from_service(identity, primary))
        }
        RuntimeExit::Network(result) => {
            let primary = network_exit_failure(result);
            log_secondary_failures(&identity, &primary, stop_failures);
            Err(runtime_failure_from_service(identity, primary))
        }
        RuntimeExit::Execution => {
            let primary = ServiceFailure {
                component: "executor",
                error_type: RuntimeErrorCode::ChildProcessContainmentUnproven,
                message: "Execution Actor could not complete its owned invocation".into(),
            };
            log_secondary_failures(&identity, &primary, stop_failures);
            Err(runtime_failure_from_service(identity, primary))
        }
        RuntimeExit::Reaper(result) => {
            let primary = ServiceFailure {
                component: "process_reaper",
                error_type: RuntimeErrorCode::OrphanReaperFailed,
                message: result.err().map_or_else(
                    || "orphan reaper stopped unexpectedly".into(),
                    |error| error.to_string(),
                ),
            };
            log_secondary_failures(&identity, &primary, stop_failures);
            Err(runtime_failure_from_service(identity, primary))
        }
        RuntimeExit::Managed(error) => {
            let primary = ServiceFailure {
                component: "managed_mcp",
                error_type: error.code,
                message: error.to_string(),
            };
            log_secondary_failures(&identity, &primary, stop_failures);
            Err(runtime_failure_from_service(identity, primary))
        }
        RuntimeExit::Shutdown => runtime_shutdown_result(identity, stop_failures),
    }
}

#[cfg(target_os = "linux")]
async fn stop_runtime_services<HF, NF>(
    wait_http: bool,
    wait_network: bool,
    http: &mut std::pin::Pin<Box<HF>>,
    network: &mut std::pin::Pin<Box<NF>>,
    actor: &execution_actor::ExecutionActor,
    timeout: std::time::Duration,
) -> Vec<ServiceFailure>
where
    HF: std::future::Future<Output = Result<(), std::io::Error>>,
    NF: std::future::Future<Output = Result<(), network_session::NetworkSessionError>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    let (http, network, actor) = tokio::join!(
        wait_for_service(
            wait_http,
            "http",
            http,
            |_| RuntimeErrorCode::HttpServiceFailed,
            deadline,
            timeout,
        ),
        wait_for_service(
            wait_network,
            "network",
            network,
            |error| error.code(),
            deadline,
            timeout,
        ),
        wait_for_actor(actor.drain(), deadline, timeout),
    );
    [http, network, actor].into_iter().flatten().collect()
}

#[cfg(target_os = "linux")]
async fn wait_for_service<F, E, C>(
    wait: bool,
    name: &'static str,
    service: &mut std::pin::Pin<Box<F>>,
    error_code: C,
    deadline: tokio::time::Instant,
    timeout: std::time::Duration,
) -> Option<ServiceFailure>
where
    F: std::future::Future<Output = Result<(), E>>,
    E: std::error::Error,
    C: FnOnce(&E) -> RuntimeErrorCode,
{
    if !wait {
        return None;
    }
    match tokio::time::timeout_at(deadline, service.as_mut()).await {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(ServiceFailure {
            component: name,
            error_type: error_code(&error),
            message: error.to_string(),
        }),
        Err(_) => Some(shutdown_timeout_failure(name, timeout)),
    }
}

#[cfg(target_os = "linux")]
async fn wait_for_actor<F>(
    drain: F,
    deadline: tokio::time::Instant,
    timeout: std::time::Duration,
) -> Option<ServiceFailure>
where
    F: std::future::Future<Output = Result<(), execution_actor::ExecutionFatal>>,
{
    match tokio::time::timeout_at(deadline, drain).await {
        Ok(Ok(())) => None,
        Ok(Err(_)) => Some(ServiceFailure {
            component: "executor",
            error_type: RuntimeErrorCode::ChildProcessContainmentUnproven,
            message: "Execution Actor could not complete its owned invocation".into(),
        }),
        Err(_) => Some(shutdown_timeout_failure("executor", timeout)),
    }
}

fn shutdown_timeout_failure(
    component: &'static str,
    timeout: std::time::Duration,
) -> ServiceFailure {
    ServiceFailure {
        component,
        error_type: RuntimeErrorCode::ShutdownTimeout,
        message: format!("{component} did not stop within {timeout:?}"),
    }
}

#[cfg(target_os = "linux")]
fn runtime_shutdown_result(
    identity: spec::RuntimeIdentity,
    mut failures: Vec<ServiceFailure>,
) -> Result<(), RuntimeFailure> {
    if failures.is_empty() {
        return Ok(());
    }
    failures.sort_by_key(|failure| failure.error_type == RuntimeErrorCode::ShutdownTimeout);
    let primary = failures.remove(0);
    log_secondary_failures(&identity, &primary, failures);
    Err(runtime_failure_from_service(identity, primary))
}

#[cfg(target_os = "linux")]
fn http_exit_failure(result: Result<(), std::io::Error>) -> ServiceFailure {
    match result {
        Ok(()) => ServiceFailure {
            component: "http",
            error_type: RuntimeErrorCode::UnexpectedExit,
            message: "HTTP service stopped without shutdown".into(),
        },
        Err(error) => ServiceFailure {
            component: "http",
            error_type: RuntimeErrorCode::HttpServiceFailed,
            message: error.to_string(),
        },
    }
}

#[cfg(target_os = "linux")]
fn network_exit_failure(
    result: Result<(), network_session::NetworkSessionError>,
) -> ServiceFailure {
    match result {
        Ok(()) => ServiceFailure {
            component: "network",
            error_type: RuntimeErrorCode::UnexpectedExit,
            message: "network service stopped without shutdown".into(),
        },
        Err(error) => ServiceFailure {
            component: "network",
            error_type: error.code(),
            message: error.to_string(),
        },
    }
}

fn runtime_failure(
    identity: spec::RuntimeIdentity,
    component: &'static str,
    error_type: RuntimeErrorCode,
    error: impl std::fmt::Display,
) -> RuntimeFailure {
    RuntimeFailure {
        identity,
        component,
        error_type,
        message: error.to_string(),
    }
}

fn runtime_failure_from_service(
    identity: spec::RuntimeIdentity,
    failure: ServiceFailure,
) -> RuntimeFailure {
    RuntimeFailure {
        identity,
        component: failure.component,
        error_type: failure.error_type,
        message: failure.message,
    }
}

fn log_secondary_failures(
    identity: &spec::RuntimeIdentity,
    primary: &ServiceFailure,
    failures: Vec<ServiceFailure>,
) {
    for failure in failures {
        if failure.component != primary.component || failure.error_type != primary.error_type {
            log_secondary_failure(identity, &failure);
        }
    }
}

fn log_secondary_failure(identity: &spec::RuntimeIdentity, failure: &ServiceFailure) {
    tracing::warn!(
        component = failure.component,
        error.type = failure.error_type.as_str(),
        reason = failure.message,
        "antnest.agent.id" = identity.agent_id(),
        "antnest.runtime.generation" = %identity.generation(),
        "Runtime component also failed while stopping"
    );
}

#[cfg(target_os = "linux")]
fn log_shutdown(signal: &'static str, agent_id: &str, generation: u64) {
    tracing::info!(
        signal,
        "antnest.agent.id" = agent_id,
        "antnest.runtime.generation" = %generation,
        "Runtime shutdown requested"
    );
}

#[cfg(not(target_os = "linux"))]
fn run() -> Result<(), ExitError> {
    Err(ExitError::Bootstrap(bootstrap_failure(
        BootstrapStage::Platform,
        BootstrapErrorCode::UnsupportedPlatform,
        None,
        std::io::Error::other("antnest-runtime requires Linux"),
    )))
}

#[cfg(all(test, target_os = "linux"))]
mod lifecycle_tests {
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::{
        RuntimeExit, ServiceFailure, http_exit_failure, network_exit_failure,
        runtime_shutdown_result, stop_runtime_services, wait_for_actor,
    };
    use crate::execution_actor::ExecutionFatal;
    use crate::lifecycle_error::RuntimeErrorCode;
    use crate::network_session::NetworkSessionError;
    use crate::spec::RuntimeIdentity;

    #[test]
    fn service_failures_keep_stable_component_codes() {
        let http = http_exit_failure(Err(std::io::Error::other("listener failed")));
        assert_eq!(http.component, "http");
        assert_eq!(http.error_type, RuntimeErrorCode::HttpServiceFailed);

        let network =
            network_exit_failure(Err(NetworkSessionError::Transport("UDP failed".into())));
        assert_eq!(network.component, "network");
        assert_eq!(network.error_type, RuntimeErrorCode::NetworkTransportFailed);
    }

    #[test]
    fn clean_component_exit_is_still_a_runtime_failure() {
        assert_eq!(
            http_exit_failure(Ok(())).error_type,
            RuntimeErrorCode::UnexpectedExit
        );
        assert_eq!(
            network_exit_failure(Ok(())).error_type,
            RuntimeErrorCode::UnexpectedExit
        );
    }

    #[test]
    fn clean_service_exit_racing_with_shutdown_is_not_a_failure() {
        assert!(matches!(
            RuntimeExit::Http(Ok(())).normalize(true),
            RuntimeExit::Shutdown
        ));
        assert!(matches!(
            RuntimeExit::Network(Ok(())).normalize(true),
            RuntimeExit::Shutdown
        ));
        assert!(matches!(
            RuntimeExit::Http(Ok(())).normalize(false),
            RuntimeExit::Http(Ok(()))
        ));
    }

    #[tokio::test]
    async fn stopping_services_retains_completed_failure_when_peer_times_out() {
        let (actor, _failures) = crate::execution_actor::ExecutionActor::new(
            RuntimeIdentity::new("agent-test", 1).unwrap(),
            "/workspace".into(),
            "/skills".into(),
            crate::telemetry::RuntimeMetrics::default(),
            CancellationToken::new(),
        );
        let mut http = Box::pin(async { Err(std::io::Error::other("listener failed")) });
        let mut network = Box::pin(std::future::pending::<Result<(), NetworkSessionError>>());

        let failures = stop_runtime_services(
            true,
            true,
            &mut http,
            &mut network,
            &actor,
            Duration::from_millis(10),
        )
        .await;

        assert_eq!(failures.len(), 2);
        assert!(
            failures
                .iter()
                .any(|failure| failure.error_type == RuntimeErrorCode::HttpServiceFailed)
        );
        assert!(failures.iter().any(|failure| {
            failure.component == "network"
                && failure.error_type == RuntimeErrorCode::ShutdownTimeout
        }));
    }

    #[test]
    fn completed_shutdown_failure_precedes_timeout_diagnostic() {
        let failures = vec![
            ServiceFailure {
                component: "network",
                error_type: RuntimeErrorCode::ShutdownTimeout,
                message: "network timed out".into(),
            },
            ServiceFailure {
                component: "http",
                error_type: RuntimeErrorCode::HttpServiceFailed,
                message: "listener failed".into(),
            },
        ];

        let error =
            runtime_shutdown_result(RuntimeIdentity::new("agent-test", 1).unwrap(), failures)
                .unwrap_err();

        assert_eq!(error.component, "http");
        assert_eq!(error.error_type, RuntimeErrorCode::HttpServiceFailed);
    }

    #[tokio::test]
    async fn actor_timeout_does_not_replace_a_completed_failure() {
        let timeout = Duration::from_millis(10);
        let actor_timeout = wait_for_actor(
            std::future::pending::<Result<(), ExecutionFatal>>(),
            tokio::time::Instant::now() + timeout,
            timeout,
        )
        .await
        .unwrap();
        let failures = vec![
            actor_timeout,
            ServiceFailure {
                component: "http",
                error_type: RuntimeErrorCode::HttpServiceFailed,
                message: "listener failed".into(),
            },
        ];

        let error =
            runtime_shutdown_result(RuntimeIdentity::new("agent-test", 1).unwrap(), failures)
                .unwrap_err();

        assert_eq!(error.error_type, RuntimeErrorCode::HttpServiceFailed);
    }

    #[tokio::test]
    async fn actor_containment_failure_precedes_timeout_diagnostic() {
        let timeout = Duration::from_secs(1);
        let containment = wait_for_actor(
            std::future::ready(Err(ExecutionFatal)),
            tokio::time::Instant::now() + timeout,
            timeout,
        )
        .await
        .unwrap();
        let failures = vec![
            ServiceFailure {
                component: "network",
                error_type: RuntimeErrorCode::ShutdownTimeout,
                message: "network timed out".into(),
            },
            containment,
        ];

        let error =
            runtime_shutdown_result(RuntimeIdentity::new("agent-test", 1).unwrap(), failures)
                .unwrap_err();

        assert_eq!(
            error.error_type,
            RuntimeErrorCode::ChildProcessContainmentUnproven
        );
    }
}

#[cfg(test)]
mod bootstrap_event_tests {
    use super::bootstrap_stage_event;
    use crate::lifecycle_error::BootstrapStage;
    use crate::spec::RuntimeIdentity;

    #[test]
    fn bootstrap_event_is_structured_and_content_free() {
        let identity = RuntimeIdentity::new("agent-observed", 7).unwrap();
        let event = bootstrap_stage_event(BootstrapStage::NetworkReady, Some(&identity));

        assert_eq!(event["lifecycle.event"], "bootstrap_stage_completed");
        assert_eq!(event["bootstrap.stage"], "network_ready");
        assert_eq!(event["antnest.agent.id"], "agent-observed");
        assert_eq!(event["antnest.runtime.generation"], "7");
        assert!(event.get("runtime_spec").is_none());
        assert!(event.get("environment").is_none());
    }
}
