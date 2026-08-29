use std::fs::File;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::io::unix::AsyncFd;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::network::RuntimeNetwork;
use crate::packet::{is_forwardable_ipv4_tcp, tunnel_datagram, unsupported_ipv4_rejection};
use crate::spec::RuntimeIdentity;
use crate::telemetry::RuntimeMetrics;

const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Error)]
pub(crate) enum NetworkSessionError {
    #[error("Runtime network transport: {0}")]
    Transport(String),
    #[error("Runtime local network boundary: {0}")]
    Local(String),
}

impl NetworkSessionError {
    pub(crate) fn code(&self) -> crate::lifecycle_error::RuntimeErrorCode {
        match self {
            Self::Transport(_) => crate::lifecycle_error::RuntimeErrorCode::NetworkTransportFailed,
            Self::Local(_) => crate::lifecycle_error::RuntimeErrorCode::LocalNetworkFailed,
        }
    }
}

pub(crate) struct NetworkSession(UdpNetwork);

impl NetworkSession {
    pub(crate) async fn prepare(network: RuntimeNetwork) -> Result<Self, NetworkSessionError> {
        let (tun, mtu, egress_endpoint) = network.into_transport();
        Ok(Self(UdpNetwork::connect(
            SocketAddr::V4(egress_endpoint.address()),
            usize::from(mtu),
            tun,
        )?))
    }

    pub(crate) async fn run(
        self,
        shutdown: CancellationToken,
        identity: RuntimeIdentity,
        metrics: RuntimeMetrics,
    ) -> Result<(), NetworkSessionError> {
        let span = tracing::info_span!(
            "runtime.network",
            "service.name" = crate::telemetry::SERVICE_NAME,
            "antnest.agent.id" = identity.agent_id(),
            "antnest.runtime.generation" = %identity.generation(),
            "network.transport" = "udp_tunnel",
            "network.session.outcome" = tracing::field::Empty,
            "network.session.duration_ms" = tracing::field::Empty,
            otel.status_code = tracing::field::Empty,
            "error.type" = tracing::field::Empty,
            trace_id = tracing::field::Empty,
            span_id = tracing::field::Empty,
        );
        crate::telemetry::record_span_identity(&span);
        span.in_scope(|| {
            tracing::info!(
                lifecycle.event = "network_session_started",
                "Runtime network session started"
            );
        });
        let started = tokio::time::Instant::now();
        let result = self.0.run(shutdown, metrics).instrument(span.clone()).await;
        record_network_result(&span, &result, started.elapsed());
        result
    }
}

fn record_network_result(
    span: &tracing::Span,
    result: &Result<(), NetworkSessionError>,
    duration: Duration,
) {
    span.record(
        "network.session.duration_ms",
        u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
    );
    let (outcome, error_type) = match result {
        Ok(()) => ("success", ""),
        Err(error) => ("error", error.code().as_str()),
    };
    span.record("network.session.outcome", outcome);
    span.record(
        "otel.status_code",
        if result.is_ok() { "OK" } else { "ERROR" },
    );
    span.record("error.type", error_type);
    span.in_scope(|| {
        tracing::info!(
            lifecycle.event = "network_session_completed",
            outcome,
            error.type = error_type,
            "Runtime network session completed"
        );
    });
}

pub(crate) struct UdpNetwork {
    socket: tokio::net::UdpSocket,
    mtu: usize,
    tun: File,
}

struct NetworkMetrics {
    exporter: RuntimeMetrics,
    outbound_packets: u64,
    outbound_bytes: u64,
    inbound_packets: u64,
    inbound_bytes: u64,
    unsupported_outbound_packets: u64,
    local_rejections: u64,
    malformed_inbound_packets: u64,
}

impl NetworkMetrics {
    fn new(exporter: RuntimeMetrics) -> Self {
        Self {
            exporter,
            outbound_packets: 0,
            outbound_bytes: 0,
            inbound_packets: 0,
            inbound_bytes: 0,
            unsupported_outbound_packets: 0,
            local_rejections: 0,
            malformed_inbound_packets: 0,
        }
    }

    fn outbound(&mut self, bytes: usize) {
        self.exporter.network_outbound(bytes);
        self.outbound_packets = self.outbound_packets.saturating_add(1);
        self.outbound_bytes = self
            .outbound_bytes
            .saturating_add(u64::try_from(bytes).unwrap_or(u64::MAX));
    }

    fn inbound(&mut self, bytes: usize) {
        self.exporter.network_inbound(bytes);
        self.inbound_packets = self.inbound_packets.saturating_add(1);
        self.inbound_bytes = self
            .inbound_bytes
            .saturating_add(u64::try_from(bytes).unwrap_or(u64::MAX));
    }

    fn unsupported_outbound(&mut self, rejected: bool) {
        self.exporter.network_unsupported(rejected);
        self.unsupported_outbound_packets = self.unsupported_outbound_packets.saturating_add(1);
        self.local_rejections = self.local_rejections.saturating_add(u64::from(rejected));
    }

    fn malformed_inbound(&mut self) {
        self.exporter.network_malformed();
        self.malformed_inbound_packets = self.malformed_inbound_packets.saturating_add(1);
    }

    fn log(&self) {
        tracing::info!(
            metric.event = "runtime_network_snapshot",
            outbound.packets = self.outbound_packets,
            outbound.bytes = self.outbound_bytes,
            inbound.packets = self.inbound_packets,
            inbound.bytes = self.inbound_bytes,
            outbound.unsupported = self.unsupported_outbound_packets,
            outbound.local_rejections = self.local_rejections,
            inbound.malformed = self.malformed_inbound_packets,
            "Runtime network aggregate"
        );
    }
}

impl UdpNetwork {
    fn connect(address: SocketAddr, mtu: usize, tun: File) -> Result<Self, NetworkSessionError> {
        let socket = connect_management_udp(address)?;
        Ok(Self { socket, mtu, tun })
    }

    async fn run(
        self,
        shutdown: CancellationToken,
        exporter: RuntimeMetrics,
    ) -> Result<(), NetworkSessionError> {
        let tun = Arc::new(AsyncFd::new(self.tun).map_err(local_error)?);
        let mut outbound = vec![0_u8; self.mtu];
        let mut inbound = vec![0_u8; self.mtu];
        let mut metrics = NetworkMetrics::new(exporter);
        let mut report = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(30),
            Duration::from_secs(30),
        );
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                _ = report.tick() => metrics.log(),
                read = read_tun(&tun, &mut outbound) => {
                    let size = read?;
                    let packet = &outbound[..size];
                    if !is_forwardable_ipv4_tcp(packet, self.mtu) {
                        let rejection = unsupported_ipv4_rejection(packet);
                        metrics.unsupported_outbound(rejection.is_some());
                        if let Some(rejection) = rejection {
                            write_tun_bounded(&tun, &rejection).await?;
                        }
                        continue;
                    }
                    send_udp_bounded(&self.socket, packet).await?;
                    metrics.outbound(size);
                }
                received = self.socket.recv(&mut inbound) => {
                    let size = received.map_err(transport_error)?;
                    let Some(packet) = validated_inbound_datagram(&inbound[..size], self.mtu) else {
                        metrics.malformed_inbound();
                        continue;
                    };
                    write_tun_bounded(&tun, packet).await?;
                    metrics.inbound(size);
                }
            }
        }
    }
}

fn validated_inbound_datagram(packet: &[u8], mtu: usize) -> Option<&[u8]> {
    tunnel_datagram(packet, mtu).ok()
}

fn connect_management_udp(
    address: SocketAddr,
) -> Result<tokio::net::UdpSocket, NetworkSessionError> {
    let local = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0));
    let socket = std::net::UdpSocket::bind(local).map_err(transport_error)?;
    socket.connect(address).map_err(transport_error)?;
    socket.set_nonblocking(true).map_err(local_error)?;
    tokio::net::UdpSocket::from_std(socket).map_err(local_error)
}

async fn send_udp_bounded(
    socket: &tokio::net::UdpSocket,
    packet: &[u8],
) -> Result<(), NetworkSessionError> {
    let size = tokio::time::timeout(WRITE_TIMEOUT, socket.send(packet))
        .await
        .map_err(|_| transport_error("UDP Egress write timed out"))?
        .map_err(transport_error)?;
    if size != packet.len() {
        return Err(transport_error("UDP Egress write was incomplete"));
    }
    Ok(())
}

async fn write_tun_bounded(tun: &AsyncFd<File>, packet: &[u8]) -> Result<(), NetworkSessionError> {
    tokio::time::timeout(WRITE_TIMEOUT, write_tun(tun, packet))
        .await
        .map_err(|_| local_error("TUN write timed out"))?
}

async fn read_tun(tun: &AsyncFd<File>, buffer: &mut [u8]) -> Result<usize, NetworkSessionError> {
    loop {
        let mut ready = tun.readable().await.map_err(local_error)?;
        match ready.try_io(|inner| read_fd(inner.get_ref(), buffer)) {
            Ok(result) => return result.map_err(local_error),
            Err(_) => continue,
        }
    }
}

async fn write_tun(tun: &AsyncFd<File>, mut packet: &[u8]) -> Result<(), NetworkSessionError> {
    while !packet.is_empty() {
        let mut ready = tun.writable().await.map_err(local_error)?;
        let written = match ready.try_io(|inner| write_fd(inner.get_ref(), packet)) {
            Ok(result) => result.map_err(local_error)?,
            Err(_) => continue,
        };
        if written == 0 {
            return Err(local_error(io::Error::from(io::ErrorKind::WriteZero)));
        }
        packet = &packet[written..];
    }
    Ok(())
}

fn read_fd(file: &File, buffer: &mut [u8]) -> io::Result<usize> {
    let result = unsafe { libc::read(file.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result as usize)
    }
}

fn write_fd(file: &File, packet: &[u8]) -> io::Result<usize> {
    let result = unsafe { libc::write(file.as_raw_fd(), packet.as_ptr().cast(), packet.len()) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result as usize)
    }
}

fn transport_error(error: impl std::fmt::Display) -> NetworkSessionError {
    NetworkSessionError::Transport(error.to_string())
}

fn local_error(error: impl std::fmt::Display) -> NetworkSessionError {
    NetworkSessionError::Local(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddrV4};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio_util::sync::CancellationToken;
    use tracing_subscriber::layer::{Context, Layer, SubscriberExt as _};

    use super::{NetworkMetrics, NetworkSession, UdpNetwork, validated_inbound_datagram};
    use crate::spec::RuntimeIdentity;
    use crate::telemetry::RuntimeMetrics;

    #[derive(Clone)]
    struct EventCounter(Arc<AtomicUsize>);

    impl<S> Layer<S> for EventCounter
    where
        S: tracing::Subscriber,
    {
        fn on_event(&self, _event: &tracing::Event<'_>, _context: Context<'_, S>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn network_session_emits_start_and_completion_events() {
        let events = Arc::new(AtomicUsize::new(0));
        let subscriber = tracing_subscriber::Registry::default().with(EventCounter(events.clone()));
        let metrics = RuntimeMetrics::default();
        let _guard = tracing::subscriber::set_default(subscriber);
        let socket = std::net::UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("test UDP socket");
        socket.set_nonblocking(true).expect("nonblocking UDP");
        let (reader, _writer) = nix::unistd::pipe().expect("test pipe");
        let network = NetworkSession(UdpNetwork {
            socket: tokio::net::UdpSocket::from_std(socket).expect("async UDP socket"),
            mtu: 64,
            tun: std::fs::File::from(reader),
        });
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        network
            .run(
                shutdown,
                RuntimeIdentity::new("agent-observed", 1).unwrap(),
                metrics,
            )
            .await
            .expect("canceled network session stops cleanly");

        assert_eq!(events.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn malformed_egress_datagrams_are_local_packet_loss_not_session_failure() {
        assert!(validated_inbound_datagram(&[0_u8; 7], 1400).is_none());
    }

    #[test]
    fn network_metrics_are_bounded_process_local_aggregates() {
        let mut metrics = NetworkMetrics::new(RuntimeMetrics::default());
        metrics.outbound(40);
        metrics.inbound(60);
        metrics.unsupported_outbound(true);
        metrics.malformed_inbound();

        assert_eq!(metrics.outbound_packets, 1);
        assert_eq!(metrics.outbound_bytes, 40);
        assert_eq!(metrics.inbound_packets, 1);
        assert_eq!(metrics.inbound_bytes, 60);
        assert_eq!(metrics.unsupported_outbound_packets, 1);
        assert_eq!(metrics.local_rejections, 1);
        assert_eq!(metrics.malformed_inbound_packets, 1);
    }
}
