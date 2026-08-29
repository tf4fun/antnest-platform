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
use crate::packet::{is_forwardable_ipv4_tcp, tunnel_datagram};
use crate::spec::RuntimeIdentity;

const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Error)]
pub(crate) enum NetworkSessionError {
    #[error("Runtime network transport: {0}")]
    Transport(String),
    #[error("Runtime network protocol: {0}")]
    Protocol(String),
    #[error("Runtime local network boundary: {0}")]
    Local(String),
}

impl NetworkSessionError {
    pub(crate) fn code(&self) -> crate::lifecycle_error::RuntimeErrorCode {
        match self {
            Self::Transport(_) => crate::lifecycle_error::RuntimeErrorCode::NetworkTransportFailed,
            Self::Protocol(_) => crate::lifecycle_error::RuntimeErrorCode::NetworkProtocolFailed,
            Self::Local(_) => crate::lifecycle_error::RuntimeErrorCode::LocalNetworkFailed,
        }
    }
}

pub(crate) enum NetworkSession {
    Restricted(RestrictedNetwork),
    Udp(UdpNetwork),
}

impl NetworkSession {
    pub(crate) async fn prepare(network: RuntimeNetwork) -> Result<Self, NetworkSessionError> {
        match network {
            RuntimeNetwork::Restricted { tun, mtu, .. } => Ok(Self::Restricted(
                RestrictedNetwork::new(usize::from(mtu), tun)?,
            )),
            RuntimeNetwork::Unrestricted {
                tun,
                mtu,
                egress_endpoint,
                ..
            } => Ok(Self::Udp(UdpNetwork::connect(
                SocketAddr::V4(egress_endpoint.address()),
                usize::from(mtu),
                tun,
            )?)),
        }
    }

    pub(crate) async fn run(
        self,
        shutdown: CancellationToken,
        identity: RuntimeIdentity,
    ) -> Result<(), NetworkSessionError> {
        let (mode, transport) = match &self {
            Self::Restricted(_) => ("restricted", "local_reject"),
            Self::Udp(_) => ("unrestricted", "udp_tunnel"),
        };
        let span = tracing::info_span!(
            "runtime.network",
            "service.name" = crate::telemetry::SERVICE_NAME,
            "antnest.agent.id" = identity.agent_id(),
            "antnest.runtime.generation" = %identity.generation(),
            "antnest.runtime.network_mode" = mode,
            "network.transport" = transport,
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
        let result = async move {
            match self {
                Self::Restricted(network) => network.run(shutdown).await,
                Self::Udp(network) => network.run(shutdown).await,
            }
        }
        .instrument(span.clone())
        .await;
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

pub(crate) struct RestrictedNetwork {
    tun: Arc<AsyncFd<File>>,
    packet: Vec<u8>,
}

impl RestrictedNetwork {
    fn new(mtu: usize, tun: File) -> Result<Self, NetworkSessionError> {
        Ok(Self {
            tun: Arc::new(AsyncFd::new(tun).map_err(local_error)?),
            packet: vec![0_u8; mtu],
        })
    }

    async fn run(mut self, shutdown: CancellationToken) -> Result<(), NetworkSessionError> {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                read = read_tun(&self.tun, &mut self.packet) => {
                    let size = read?;
                    if let Some(rejection) = crate::packet::restricted_ipv4_rejection(&self.packet[..size]) {
                        write_tun_bounded(&self.tun, &rejection).await?;
                    }
                }
            }
        }
    }
}

pub(crate) struct UdpNetwork {
    socket: tokio::net::UdpSocket,
    mtu: usize,
    tun: File,
}

impl UdpNetwork {
    fn connect(address: SocketAddr, mtu: usize, tun: File) -> Result<Self, NetworkSessionError> {
        let socket = connect_management_udp(address)?;
        Ok(Self { socket, mtu, tun })
    }

    async fn run(self, shutdown: CancellationToken) -> Result<(), NetworkSessionError> {
        let tun = Arc::new(AsyncFd::new(self.tun).map_err(local_error)?);
        let mut outbound = vec![0_u8; self.mtu];
        let mut inbound = vec![0_u8; self.mtu];
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                read = read_tun(&tun, &mut outbound) => {
                    let size = read?;
                    let packet = &outbound[..size];
                    if !is_forwardable_ipv4_tcp(packet, self.mtu) {
                        if let Some(rejection) = crate::packet::restricted_ipv4_rejection(packet) {
                            write_tun_bounded(&tun, &rejection).await?;
                        }
                        continue;
                    }
                    let datagram = tunnel_datagram(packet, self.mtu).map_err(protocol_error)?;
                    send_udp_bounded(&self.socket, datagram).await?;
                }
                received = self.socket.recv(&mut inbound) => {
                    let size = received.map_err(transport_error)?;
                    let packet = tunnel_datagram(&inbound[..size], self.mtu).map_err(protocol_error)?;
                    write_tun_bounded(&tun, packet).await?;
                }
            }
        }
    }
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

fn protocol_error(error: impl std::fmt::Display) -> NetworkSessionError {
    NetworkSessionError::Protocol(error.to_string())
}

fn local_error(error: impl std::fmt::Display) -> NetworkSessionError {
    NetworkSessionError::Local(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use nix::unistd::pipe;
    use tokio::io::unix::AsyncFd;
    use tokio_util::sync::CancellationToken;
    use tracing_subscriber::layer::{Context, Layer, SubscriberExt as _};

    use super::{NetworkSession, RestrictedNetwork};
    use crate::spec::RuntimeIdentity;

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
        let _guard = tracing::subscriber::set_default(subscriber);
        let (reader, _writer) = pipe().expect("test pipe");
        let network = NetworkSession::Restricted(RestrictedNetwork {
            tun: Arc::new(AsyncFd::new(File::from(reader)).expect("async test pipe")),
            packet: vec![0_u8; 64],
        });
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        network
            .run(shutdown, RuntimeIdentity::new("agent-observed", 1).unwrap())
            .await
            .expect("canceled network session stops cleanly");

        assert_eq!(events.load(Ordering::Relaxed), 2);
    }
}
