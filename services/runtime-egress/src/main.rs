use std::{
    error::Error,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlService},
    config::{Config, health_listen_from_env},
    control::{health_router, router},
    dns::{DnsMetrics, DnsProxyConfig, run_dns_proxy},
    kernel::{KernelPlan, LinuxKernel},
    network::run_packet_loop,
    packet::INNER_MTU,
    repository::{PostgresRepository, RepositoryConfig},
    telemetry::{EgressMetrics, Telemetry},
    transport::{SecurityConfig, VerifiedPeer, healthcheck},
    tunnel::KeyBox,
};
use tokio::{
    net::{TcpListener, UdpSocket},
    task::JoinSet,
    time::{MissedTickBehavior, interval, timeout},
};
use tokio_util::sync::CancellationToken;

const DNS_MAX_CONNECTIONS: usize = 128;
const DNS_MAX_CONNECTIONS_PER_SOURCE: usize = 8;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.len() == 2 && args[1] == "--healthcheck" {
        return healthcheck(health_listen_from_env()?)
            .await
            .map_err(Into::into);
    }
    if args.len() != 1 {
        return Err("invalid Egress command-line arguments".into());
    }
    let security = SecurityConfig::from_env()?;
    let config = Config::from_env()?;
    let key_box = KeyBox::load(&config.tunnel_key_file)?;
    let telemetry = Telemetry::init()?;
    for variable in &config.development_secret_warnings {
        tracing::warn!(variable, "Published development secret explicitly enabled");
    }
    let result = run(config, security, telemetry.metrics(), key_box).await;
    if let Err(error) = &result {
        tracing::error!(%error, "Runtime Egress stopped with an error");
    }
    telemetry.shutdown();
    result
}

async fn run(
    config: Config,
    security: SecurityConfig,
    metrics: EgressMetrics,
    key_box: KeyBox,
) -> Result<(), Box<dyn Error>> {
    let repository = Arc::new(
        PostgresRepository::connect_with_retry(
            &config.database_url,
            config.database_tls_mode,
            RepositoryConfig {
                pool_id: "default".to_owned(),
                tunnel_cidr: config.tunnel_cidr,
                resolver_ipv4: config.resolver_ipv4,
                quarantine: config.quarantine,
            },
            config.database_startup_timeout,
            config.database_retry_delay,
        )
        .await?,
    );
    let repository_health = repository.health();
    let plan = KernelPlan::new(
        config.tun_name.clone(),
        config.tunnel_cidr,
        config.resolver_ipv4,
        INNER_MTU,
    )?;
    let (kernel, tun) = LinuxKernel::bootstrap(&plan, config.command_timeout).await?;
    let dns_protected_networks = kernel.protected_ipv4_networks().to_vec();
    kernel.clear_all().await?;
    let service = Arc::new(ControlService::new(
        repository,
        Arc::new(kernel),
        ControlConfig {
            advertised_udp_endpoint: config.udp_advertise,
            resolver_ipv4: config.resolver_ipv4,
            max_flows: config.max_flows,
            max_agent_flows: config.max_agent_flows,
            flow_idle: config.flow_idle,
        },
        key_box,
    ));
    let recovered = service.recover().await?;

    let udp = UdpSocket::bind(config.udp_advertise).await?;
    let control_listener = TcpListener::bind(config.control_listen).await?;
    let health_listener = TcpListener::bind(config.health_listen).await?;
    let dns_listener =
        TcpListener::bind(SocketAddr::new(IpAddr::V4(config.resolver_ipv4), 53)).await?;
    let dns_metrics = Arc::new(DnsMetrics::default());
    let cancellation = CancellationToken::new();
    let app = router(service.clone(), metrics.clone(), security.admission());
    let health_app = health_router(service.clone(), metrics.clone());
    let control_listener = security.listener(control_listener);
    tracing::info!(
        control = %config.control_listen,
        health = %config.health_listen,
        udp = %config.udp_advertise,
        advertised_udp = %config.udp_advertise,
        recovered_agent_networks = recovered,
        "Runtime Egress ready"
    );

    let mut tasks = JoinSet::new();
    let packet_cancellation = cancellation.clone();
    let packet_engine = service.dataplane();
    let packet_output_barrier = service.output_barrier();
    tasks.spawn(async move {
        task_result(
            "packet",
            run_packet_loop(
                udp,
                tun,
                packet_engine,
                packet_output_barrier,
                INNER_MTU,
                Duration::from_millis(100),
                packet_cancellation,
            )
            .await,
        )
    });
    let dns_cancellation = cancellation.clone();
    let dns_task_metrics = dns_metrics.clone();
    tasks.spawn(async move {
        task_result(
            "DNS",
            run_dns_proxy(
                dns_listener,
                DnsProxyConfig {
                    upstream: config.dns_upstream,
                    protected_networks: dns_protected_networks,
                    max_connections: DNS_MAX_CONNECTIONS,
                    max_connections_per_source: DNS_MAX_CONNECTIONS_PER_SOURCE,
                    connection_timeout: Duration::from_secs(10),
                },
                dns_task_metrics,
                dns_cancellation,
            )
            .await,
        )
    });
    let http_cancellation = cancellation.clone();
    tasks.spawn(async move {
        task_result(
            "control HTTP",
            axum::serve(
                control_listener,
                app.into_make_service_with_connect_info::<VerifiedPeer>(),
            )
            .with_graceful_shutdown(http_cancellation.cancelled_owned())
            .await,
        )
    });
    let probe_cancellation = cancellation.clone();
    tasks.spawn(async move {
        task_result(
            "health HTTP",
            axum::serve(health_listener, health_app)
                .with_graceful_shutdown(probe_cancellation.cancelled_owned())
                .await,
        )
    });
    let sweep_cancellation = cancellation.clone();
    let sweep_service = service.clone();
    let sweep_metrics = metrics.clone();
    tasks.spawn(async move {
        task_result(
            "quarantine sweeper",
            sweep_loop(
                sweep_service,
                config.quarantine,
                sweep_metrics,
                sweep_cancellation,
            )
            .await,
        )
    });
    let metrics_cancellation = cancellation.clone();
    let metrics_service = service.clone();
    tasks.spawn(async move {
        task_result(
            "data-plane metrics",
            metrics_loop(metrics_service, dns_metrics, metrics, metrics_cancellation).await,
        )
    });
    let health_cancellation = cancellation.clone();
    let health_service = service.clone();
    tasks.spawn(async move {
        task_result(
            "repository health",
            repository_health_loop(health_service, repository_health, health_cancellation).await,
        )
    });

    let failure = tokio::select! {
        signal = shutdown_signal() => signal.err().map(|error| error.to_string()),
        result = tasks.join_next() => Some(join_failure(result)),
    };
    cancellation.cancel();
    if timeout(Duration::from_secs(5), async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
    if let Some(failure) = failure {
        return Err(failure.into());
    }
    Ok(())
}

async fn repository_health_loop<R, K>(
    service: Arc<ControlService<R, K>>,
    mut health: tokio::sync::watch::Receiver<bool>,
    cancellation: CancellationToken,
) -> Result<(), String>
where
    R: antnest_runtime_egress::repository::Repository,
    K: antnest_runtime_egress::application::KernelCleanup,
{
    service.observe_repository_health(*health.borrow());
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            changed = health.changed() => {
                changed.map_err(|_| "repository health channel closed".to_owned())?;
                service.observe_repository_health(*health.borrow_and_update());
            }
        }
    }
}

async fn metrics_loop<R, K>(
    service: Arc<ControlService<R, K>>,
    dns: Arc<DnsMetrics>,
    exporter: EgressMetrics,
    cancellation: CancellationToken,
) -> Result<(), String>
where
    R: antnest_runtime_egress::repository::Repository,
    K: antnest_runtime_egress::application::KernelCleanup,
{
    let mut ticker = interval(Duration::from_secs(30));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut observed_health_transitions = 0;
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            _ = ticker.tick() => {
                let metrics = service
                    .dataplane()
                    .lock()
                    .map_err(|_| "data-plane state is poisoned".to_owned())?
                    .metrics();
                let dns = dns.snapshot();
                let health = service.health_metrics();
                let transition_delta = health
                    .transitions
                    .saturating_sub(observed_health_transitions);
                observed_health_transitions = health.transitions;
                exporter.data_plane(metrics, dns);
                exporter.health(health, transition_delta);
                tracing::info!(
                    metric.event = "data_plane_snapshot",
                    uplink.packets = metrics.uplink_packets,
                    uplink.bytes = metrics.uplink_bytes,
                    downlink.packets = metrics.downlink_packets,
                    downlink.bytes = metrics.downlink_bytes,
                    policy.allows = metrics.policy_allows,
                    policy.denials = metrics.policy_denials,
                    packet.malformed = metrics.malformed_packets,
                    packet.unsupported = metrics.unsupported_packets,
                    agent.unknown = metrics.unknown_agents,
                    agent.fenced_packets = metrics.fenced_packets,
                    flow.active = metrics.active_flows,
                    flow.expirations = metrics.flow_expirations,
                    flow.collisions = metrics.flow_collisions,
                    flow.capacity_rejections = metrics.flow_capacity_rejections,
                    flow.reverse_misses = metrics.reverse_flow_misses,
                    peer_output.failures = metrics.peer_output_failures,
                    peer.mismatches = metrics.peer_mismatches,
                    tunnel.authentication_drops = metrics.authentication_drops,
                    tunnel.replay_drops = metrics.replay_drops,
                    tunnel.unknown_context_drops = metrics.unknown_context_drops,
                    udp.receive_errors.unattributed = metrics.unattributed_udp_receive_errors,
                    dns.connections.accepted = dns.accepted_connections,
                    dns.connections.rejected = dns.rejected_connections,
                    dns.connections.completed = dns.completed_connections,
                    dns.proxy.failures = dns.proxy_failures,
                    dns.client_to_upstream.bytes = dns.client_to_upstream_bytes,
                    dns.upstream_to_client.bytes = dns.upstream_to_client_bytes,
                    dns.answers.filtered = dns.filtered_answers,
                    health.ready = health.service_ready,
                    health.data_plane_ready = health.data_plane_ready,
                    health.control_plane_ready = health.control_plane_ready,
                    health.fenced_agents = health.fenced_agents,
                    health.transitions = health.transitions,
                    "Runtime Egress data-plane aggregate"
                );
            }
        }
    }
}

async fn sweep_loop<R, K>(
    service: Arc<ControlService<R, K>>,
    quarantine: Duration,
    metrics: EgressMetrics,
    cancellation: CancellationToken,
) -> Result<(), String>
where
    R: antnest_runtime_egress::repository::Repository,
    K: antnest_runtime_egress::application::KernelCleanup,
{
    let cadence = quarantine
        .div_f64(2.0)
        .clamp(Duration::from_secs(1), Duration::from_secs(60));
    let mut ticker = interval(cadence);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            _ = ticker.tick() => {
                let result = service.sweep_quarantine(std::time::SystemTime::now()).await;
                service.observe_control_result(&result);
                match result {
                    Ok(report) if report.examined > 0 => {
                        metrics.quarantine_sweep(report);
                        tracing::info!(
                            examined = report.examined,
                            removed = report.removed,
                            cleanup_failures = report.cleanup_failures,
                            "expired Agent network sweep completed"
                        );
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "Agent network quarantine sweep failed"),
                }
            }
        }
    }
}

fn task_result<T, E>(name: &str, result: Result<T, E>) -> Result<(), String>
where
    E: std::fmt::Display,
{
    match result {
        Ok(_) => Err(format!("{name} task exited unexpectedly")),
        Err(error) => Err(format!("{name} task failed: {error}")),
    }
}

fn join_failure(result: Option<Result<Result<(), String>, tokio::task::JoinError>>) -> String {
    match result {
        Some(Ok(Err(error))) => error,
        Some(Ok(Ok(()))) => "service task exited unexpectedly".to_owned(),
        Some(Err(error)) => format!("service task panicked: {error}"),
        None => "service task set became empty".to_owned(),
    }
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}
