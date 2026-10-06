use std::{
    collections::HashMap,
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use thiserror::Error;
use tokio::{net::UdpSocket, sync::Mutex as AsyncMutex, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::{
    dataplane::{DataPlaneAction, DataPlaneEngine},
    domain::AgentId,
};

#[derive(Clone, Debug)]
struct PeerOutput {
    agent_id: AgentId,
    peer: std::net::SocketAddr,
}

const PEER_EVENT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_PEER_EVENT_AGENTS: usize = 4096;

#[derive(Default)]
struct PeerFailureLimiter {
    last_event: HashMap<AgentId, Instant>,
}

impl PeerFailureLimiter {
    fn observe(&mut self, agent_id: AgentId, now: Instant) -> Option<AgentId> {
        self.last_event
            .retain(|_, observed| now.duration_since(*observed) < PEER_EVENT_INTERVAL);
        if self.last_event.contains_key(&agent_id) {
            return None;
        }
        if self.last_event.len() == MAX_PEER_EVENT_AGENTS
            && let Some(oldest) = self
                .last_event
                .iter()
                .min_by_key(|(_, observed)| *observed)
                .map(|(agent, _)| agent.clone())
        {
            self.last_event.remove(&oldest);
        }
        self.last_event.insert(agent_id.clone(), now);
        Some(agent_id)
    }
}

#[derive(Debug, Error)]
pub enum NetworkError {
    #[error("UDP transport failed: {0}")]
    Udp(io::Error),
    #[error("TUN transport failed: {0}")]
    Tun(io::Error),
    #[error("packet output timed out")]
    OutputTimeout,
    #[error("data-plane state is poisoned")]
    Poisoned,
    #[error("TUN device reached end of file")]
    TunClosed,
}

#[async_trait]
pub trait PacketDevice: Send + 'static {
    async fn read_packet(&mut self, buffer: &mut [u8]) -> io::Result<usize>;
    async fn write_packet(&mut self, packet: &[u8]) -> io::Result<()>;
}

pub async fn run_packet_loop<T>(
    udp: UdpSocket,
    mut tun: T,
    engine: Arc<Mutex<DataPlaneEngine>>,
    output_barrier: Arc<AsyncMutex<()>>,
    inner_mtu: usize,
    output_timeout: Duration,
    cancellation: CancellationToken,
) -> Result<(), NetworkError>
where
    T: PacketDevice,
{
    let mut udp_buffer = vec![0_u8; antnest_runtime_tunnel::MAX_DATAGRAM + 1];
    let mut crypto_clock =
        tokio::time::interval(Duration::from_millis(antnest_runtime_tunnel::TIMER_MILLIS));
    let mut tun_buffer = vec![0_u8; inner_mtu + 1];
    let mut peer_events = PeerFailureLimiter::default();

    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            _=crypto_clock.tick()=>{
                let _output=output_barrier.lock().await;
                let actions=engine.lock().map_err(|_|NetworkError::Poisoned)?.tunnel_tick();
                for action in actions {
                    let result = execute(action, &udp, &mut tun, output_timeout).await;
                    classify_output_result(None, result, &engine, &mut peer_events, Instant::now())?;
                }
            },
            received = udp.recv_from(&mut udp_buffer) => {
                let Some((length, peer)) = classify_udp_receive_result(received)? else {
                    engine
                        .lock()
                        .map_err(|_| NetworkError::Poisoned)?
                        .unattributed_udp_receive_error();
                    continue;
                };
                let packet = &udp_buffer[..length];
                let _output = output_barrier.lock().await;
                let actions = engine
                    .lock()
                    .map_err(|_| NetworkError::Poisoned)?
                    .handle_wire_uplink(packet, peer, Instant::now());
                for action in actions {
                let peer = peer_output(&action);
                let result = execute(action, &udp, &mut tun, output_timeout).await;
                classify_output_result(peer, result, &engine, &mut peer_events, Instant::now())?;
                }
            }
            read = tun.read_packet(&mut tun_buffer) => {
                let length = read.map_err(NetworkError::Tun)?;
                if length == 0 {
                    return Err(NetworkError::TunClosed);
                }
                let packet = &tun_buffer[..length];
                let _output = output_barrier.lock().await;
                let actions = engine
                    .lock()
                    .map_err(|_| NetworkError::Poisoned)?
                    .handle_wire_downlink(packet, Instant::now());
                for action in actions {
                let peer = peer_output(&action);
                let result = execute(action, &udp, &mut tun, output_timeout).await;
                classify_output_result(peer, result, &engine, &mut peer_events, Instant::now())?;
                }
            }
        }
    }
}

async fn execute<W>(
    action: DataPlaneAction,
    udp: &UdpSocket,
    tun_writer: &mut W,
    deadline: Duration,
) -> Result<(), NetworkError>
where
    W: PacketDevice,
{
    match action {
        DataPlaneAction::WriteTun(packet) => timeout(deadline, tun_writer.write_packet(&packet))
            .await
            .map_err(|_| NetworkError::OutputTimeout)?
            .map_err(NetworkError::Tun),
        DataPlaneAction::SendUdp { peer, packet, .. }
        | DataPlaneAction::SendHandshake { peer, packet } => {
            timeout(deadline, udp.send_to(&packet, peer))
                .await
                .map_err(|_| NetworkError::OutputTimeout)?
                .map(|_| ())
                .map_err(NetworkError::Udp)
        }
        DataPlaneAction::Drop(_) => Ok(()),
    }
}

fn peer_output(action: &DataPlaneAction) -> Option<PeerOutput> {
    match action {
        DataPlaneAction::SendUdp { agent_id, peer, .. } => Some(PeerOutput {
            agent_id: agent_id.clone(),
            peer: *peer,
        }),
        _ => None,
    }
}

fn classify_output_result(
    peer: Option<PeerOutput>,
    result: Result<(), NetworkError>,
    engine: &Arc<Mutex<DataPlaneEngine>>,
    events: &mut PeerFailureLimiter,
    now: Instant,
) -> Result<(), NetworkError> {
    match (peer, result) {
        (Some(peer), Err(NetworkError::Udp(error))) if is_peer_local_udp_error(&error) => {
            engine
                .lock()
                .map_err(|_| NetworkError::Poisoned)?
                .peer_output_failed(&peer.agent_id, peer.peer);
            if let Some(agent_id) = events.observe(peer.agent_id, now) {
                record_peer_failure(agent_id);
            }
            Ok(())
        }
        (None, Err(NetworkError::Udp(error))) if is_peer_local_udp_error(&error) => {
            // A handshake response has no authenticated inner-packet identity.
            // Destination-local failure must not kill the shared socket or name an Agent.
            Ok(())
        }
        (_, result) => result,
    }
}

fn record_peer_failure(agent_id: AgentId) {
    tracing::warn!(
        lifecycle.event = "runtime_peer_output_unavailable",
        antnest.agent.id = %agent_id,
        error.type = "runtime_peer_output_failed",
        "Runtime Egress peer output failed"
    );
}

fn is_peer_local_udp_error(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ECONNREFUSED) | Some(libc::EHOSTUNREACH) | Some(libc::EMSGSIZE)
    )
}

fn classify_udp_receive_result(
    result: io::Result<(usize, std::net::SocketAddr)>,
) -> Result<Option<(usize, std::net::SocketAddr)>, NetworkError> {
    match result {
        Ok(received) => Ok(Some(received)),
        Err(error) if is_unattributed_peer_udp_error(&error) => Ok(None),
        Err(error) => Err(NetworkError::Udp(error)),
    }
}

fn is_unattributed_peer_udp_error(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ECONNREFUSED)
            | Some(libc::EHOSTUNREACH)
            | Some(libc::ENETUNREACH)
            | Some(libc::EACCES)
            | Some(libc::EMSGSIZE)
    )
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use super::{
        MAX_PEER_EVENT_AGENTS, NetworkError, PEER_EVENT_INTERVAL, PeerFailureLimiter, PeerOutput,
        classify_output_result, classify_udp_receive_result,
    };
    use crate::{
        dataplane::{DataPlaneEngine, NetworkSnapshot},
        domain::AgentId,
    };

    #[test]
    fn one_runtime_peer_output_failure_is_not_a_shared_packet_loop_failure() {
        let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )));
        let peer = PeerOutput {
            agent_id: AgentId::parse("agent-one").unwrap(),
            peer: "127.0.0.1:41000".parse().unwrap(),
        };
        let mut events = PeerFailureLimiter::default();

        assert!(
            classify_output_result(
                Some(peer),
                Err(NetworkError::Udp(io::Error::from_raw_os_error(
                    libc::ECONNREFUSED,
                ))),
                &engine,
                &mut events,
                Instant::now(),
            )
            .is_ok()
        );
        assert_eq!(engine.lock().unwrap().metrics().peer_output_failures, 1);
    }

    #[test]
    fn unattributed_async_icmp_cannot_kill_the_shared_udp_socket() {
        let destination_error =
            classify_udp_receive_result(Err(io::Error::from_raw_os_error(libc::ECONNREFUSED)));
        assert!(matches!(destination_error, Ok(None)));

        let mut engine = DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        );
        engine.unattributed_udp_receive_error();
        assert_eq!(engine.metrics().unattributed_udp_receive_errors, 1);
        assert_eq!(engine.metrics().peer_output_failures, 0);

        let shared_error =
            classify_udp_receive_result(Err(io::Error::from_raw_os_error(libc::ENETDOWN)));
        assert!(matches!(shared_error, Err(NetworkError::Udp(_))));
    }

    #[test]
    fn unauthenticated_handshake_output_failure_has_no_agent_attribution() {
        let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )));
        let mut events = PeerFailureLimiter::default();
        assert!(
            classify_output_result(
                None,
                Err(NetworkError::Udp(io::Error::from_raw_os_error(
                    libc::ECONNREFUSED
                ))),
                &engine,
                &mut events,
                Instant::now()
            )
            .is_ok()
        );
        assert_eq!(engine.lock().unwrap().metrics().peer_output_failures, 0);
    }

    #[test]
    fn shared_udp_route_failure_remains_fatal() {
        let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )));
        let peer = PeerOutput {
            agent_id: AgentId::parse("agent-one").unwrap(),
            peer: "127.0.0.1:41000".parse().unwrap(),
        };
        let mut events = PeerFailureLimiter::default();

        assert!(
            classify_output_result(
                Some(peer),
                Err(NetworkError::Udp(io::Error::from_raw_os_error(
                    libc::ENETDOWN,
                ))),
                &engine,
                &mut events,
                Instant::now(),
            )
            .is_err()
        );
        assert_eq!(engine.lock().unwrap().metrics().peer_output_failures, 0);
    }

    #[test]
    fn shared_output_timeout_remains_fatal() {
        let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )));
        let peer = PeerOutput {
            agent_id: AgentId::parse("agent-one").unwrap(),
            peer: "127.0.0.1:41000".parse().unwrap(),
        };
        let mut events = PeerFailureLimiter::default();

        assert!(
            classify_output_result(
                Some(peer),
                Err(NetworkError::OutputTimeout),
                &engine,
                &mut events,
                Instant::now(),
            )
            .is_err()
        );
        assert_eq!(engine.lock().unwrap().metrics().peer_output_failures, 0);
    }

    #[test]
    fn shared_tun_failure_remains_fatal() {
        let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )));
        let mut events = PeerFailureLimiter::default();

        assert!(
            classify_output_result(
                None,
                Err(NetworkError::Tun(io::Error::other("injected TUN failure"))),
                &engine,
                &mut events,
                Instant::now(),
            )
            .is_err()
        );
    }

    #[test]
    fn peer_failure_events_are_per_agent_rate_limited_and_bounded() {
        let agent_one = AgentId::parse("agent-one").unwrap();
        let agent_two = AgentId::parse("agent-two").unwrap();
        let started = Instant::now();
        let mut limiter = PeerFailureLimiter::default();

        assert_eq!(
            limiter.observe(agent_one.clone(), started),
            Some(agent_one.clone())
        );
        assert_eq!(limiter.observe(agent_one.clone(), started), None);
        assert_eq!(limiter.observe(agent_two.clone(), started), Some(agent_two));
        assert_eq!(
            limiter.observe(agent_one.clone(), started + PEER_EVENT_INTERVAL),
            Some(agent_one)
        );

        for index in 0..=MAX_PEER_EVENT_AGENTS {
            let agent = AgentId::parse(format!("agent-{index}")).unwrap();
            limiter.observe(agent, started + PEER_EVENT_INTERVAL);
        }
        assert!(limiter.last_event.len() <= MAX_PEER_EVENT_AGENTS);
    }
}
