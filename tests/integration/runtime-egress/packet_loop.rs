#[path = "../../support/egress-auth.rs"]
mod auth;
use antnest_runtime_tunnel::{Event, MAX_DATAGRAM, Peer};

use std::{
    io,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Duration,
};

use antnest_runtime_egress::{
    dataplane::{AgentRoute, DataPlaneEngine, NetworkSnapshot, RouteGate},
    domain::AgentId,
    network::{PacketDevice, run_packet_loop},
    policy::PolicySpec,
};
use async_trait::async_trait;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UdpSocket,
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;

const SYN: &str =
    "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000";
const RESOLVER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);

struct TestTun(tokio::io::DuplexStream);

struct BlockingTun {
    write_started: Option<oneshot::Sender<()>>,
    release_write: Option<oneshot::Receiver<()>>,
}

#[async_trait]
impl PacketDevice for BlockingTun {
    async fn read_packet(&mut self, _: &mut [u8]) -> io::Result<usize> {
        std::future::pending().await
    }

    async fn write_packet(&mut self, _: &[u8]) -> io::Result<()> {
        if let Some(started) = self.write_started.take() {
            let _ = started.send(());
        }
        if let Some(release) = self.release_write.take() {
            let _ = release.await;
        }
        Ok(())
    }
}

#[async_trait]
impl PacketDevice for TestTun {
    async fn read_packet(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer).await
    }

    async fn write_packet(&mut self, packet: &[u8]) -> io::Result<()> {
        self.0.write_all(packet).await
    }
}

#[tokio::test]
async fn packet_loop_moves_uplink_and_downlink_through_authenticated_wireguard_datagrams() {
    let egress = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let egress_address = egress.local_addr().unwrap();
    let runtime = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    runtime.connect(egress_address).await.unwrap();
    let (service_tun, mut kernel_tun) = tokio::io::duplex(4096);
    let route = AgentRoute {
        agent_id: AgentId::parse("agent-1").unwrap(),
        tunnel_ipv4: "100.96.0.10".parse().unwrap(),
        assignment_version: 1,
        policy: PolicySpec::allow_all().compile(RESOLVER),
        gate: RouteGate::Open,
        runtime_endpoint: Some(Ipv4Addr::LOCALHOST),
    };
    let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
        NetworkSnapshot::from_routes([route]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    )));
    let mut crypto = install_tunnel(&engine);
    let cancellation = CancellationToken::new();
    let task = tokio::spawn(run_packet_loop(
        egress,
        TestTun(service_tun),
        engine,
        Arc::new(tokio::sync::Mutex::new(())),
        1400,
        Duration::from_secs(1),
        cancellation.clone(),
    ));
    let packet = decode_hex(SYN);

    send_encrypted(&runtime, &mut crypto, &packet).await;
    let mut uplink = vec![0_u8; 1400];
    let read = tokio::time::timeout(Duration::from_secs(2), kernel_tun.read(&mut uplink))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&uplink[..read], packet.as_slice());

    let reply = reverse_packet(&packet);
    kernel_tun.write_all(&reply).await.unwrap();
    let downlink = receive_inner(&runtime, &mut crypto).await;
    assert_eq!(downlink, reply);

    cancellation.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn deny_policy_fails_the_runtime_connection_fast() {
    let egress = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let runtime = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    runtime.connect(egress.local_addr().unwrap()).await.unwrap();
    let (service_tun, _kernel_tun) = tokio::io::duplex(4096);
    let route = AgentRoute {
        agent_id: AgentId::parse("agent-1").unwrap(),
        tunnel_ipv4: "100.96.0.10".parse().unwrap(),
        assignment_version: 1,
        policy: PolicySpec::deny_all().compile(RESOLVER),
        gate: RouteGate::Open,
        runtime_endpoint: Some(Ipv4Addr::LOCALHOST),
    };
    let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
        NetworkSnapshot::from_routes([route]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    )));
    let mut crypto = install_tunnel(&engine);
    let cancellation = CancellationToken::new();
    let task = tokio::spawn(run_packet_loop(
        egress,
        TestTun(service_tun),
        engine,
        Arc::new(tokio::sync::Mutex::new(())),
        1400,
        Duration::from_secs(1),
        cancellation.clone(),
    ));

    send_encrypted(&runtime, &mut crypto, &decode_hex(SYN)).await;
    let reply = tokio::time::timeout(
        Duration::from_millis(200),
        receive_inner(&runtime, &mut crypto),
    )
    .await
    .expect("fast encrypted rejection");
    assert_eq!(reply[33] & 0x04, 0x04);

    cancellation.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn output_barrier_is_held_until_the_packet_write_completes() {
    let egress = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let runtime = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    runtime.connect(egress.local_addr().unwrap()).await.unwrap();
    let route = AgentRoute {
        agent_id: AgentId::parse("agent-1").unwrap(),
        tunnel_ipv4: "100.96.0.10".parse().unwrap(),
        assignment_version: 1,
        policy: PolicySpec::allow_all().compile(RESOLVER),
        gate: RouteGate::Open,
        runtime_endpoint: Some(Ipv4Addr::LOCALHOST),
    };
    let engine = Arc::new(Mutex::new(DataPlaneEngine::new(
        NetworkSnapshot::from_routes([route]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    )));
    let barrier = Arc::new(tokio::sync::Mutex::new(()));
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut crypto = install_tunnel(&engine);
    let cancellation = CancellationToken::new();
    let task = tokio::spawn(run_packet_loop(
        egress,
        BlockingTun {
            write_started: Some(started_tx),
            release_write: Some(release_rx),
        },
        engine,
        barrier.clone(),
        1400,
        Duration::from_secs(1),
        cancellation.clone(),
    ));

    send_encrypted(&runtime, &mut crypto, &decode_hex(SYN)).await;
    tokio::time::timeout(Duration::from_secs(2), started_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), barrier.clone().lock_owned())
            .await
            .is_err()
    );
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), barrier.clone().lock_owned())
        .await
        .expect("barrier released after packet output");

    cancellation.cancel();
    task.await.unwrap().unwrap();
}

fn reverse_packet(packet: &[u8]) -> Vec<u8> {
    let mut reply = packet.to_vec();
    reply[12..16].copy_from_slice(&packet[16..20]);
    reply[16..20].copy_from_slice(&packet[12..16]);
    reply[20..22].copy_from_slice(&packet[22..24]);
    reply[22..24].copy_from_slice(&packet[20..22]);
    reply
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn install_tunnel(engine: &Arc<Mutex<DataPlaneEngine>>) -> Peer {
    let agent = AgentId::parse("agent-1").unwrap();
    let row = auth::key_box()
        .seal(
            agent.clone(),
            &auth::tunnel_registration(agent.as_str(), "100.96.0.10".parse().unwrap()),
        )
        .unwrap();
    let peer = auth::key_box().open(&row).unwrap().peer(row.key_id);
    let mut guard = engine.lock().unwrap();
    guard.replace_agent_tunnels(&agent, vec![(row, peer)]);
    guard.select_tunnel_key(agent, Some(auth::key_id("agent-1")));
    auth::runtime_peer("agent-1")
}
async fn send_events(socket: &UdpSocket, events: Vec<Event>) {
    for event in events {
        if let Event::Network(frame) = event {
            socket.send(&frame).await.unwrap();
        }
    }
}
async fn send_encrypted(socket: &UdpSocket, peer: &mut Peer, packet: &[u8]) {
    send_events(socket, peer.send(packet).unwrap()).await;
    let mut buffer = [0; MAX_DATAGRAM + 1];
    let size = tokio::time::timeout(Duration::from_secs(2), socket.recv(&mut buffer))
        .await
        .unwrap()
        .unwrap();
    send_events(
        socket,
        peer.receive(&buffer[..size], Ipv4Addr::LOCALHOST.into())
            .unwrap(),
    )
    .await;
}
async fn receive_inner(socket: &UdpSocket, peer: &mut Peer) -> Vec<u8> {
    let mut buffer = [0; MAX_DATAGRAM + 1];
    loop {
        let size = tokio::time::timeout(Duration::from_secs(2), socket.recv(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        for event in peer
            .receive(&buffer[..size], Ipv4Addr::LOCALHOST.into())
            .unwrap()
        {
            match event {
                Event::Ipv4(inner) => return inner,
                Event::Network(frame) => {
                    socket.send(&frame).await.unwrap();
                }
            }
        }
    }
}
