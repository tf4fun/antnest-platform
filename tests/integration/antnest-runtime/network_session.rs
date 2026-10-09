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
    crate::test_tracing::stabilize_callsite_registry();
    let _guard = tracing::subscriber::set_default(subscriber);
    let socket = std::net::UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .expect("test UDP socket");
    socket.set_nonblocking(true).expect("nonblocking UDP");
    let (reader, _writer) = nix::unistd::pipe().expect("test pipe");
    let network = NetworkSession(UdpNetwork {
        peer: crate::tunnel_auth::decode(
            &crate::tunnel_auth_tests::fixture().1,
            &crate::tunnel_auth_tests::fixture().0,
        )
        .unwrap(),
        socket: tokio::net::UdpSocket::from_std(socket).expect("async UDP socket"),
        mtu: 64,
        tun: Arc::new(
            tokio::io::unix::AsyncFd::new(std::fs::File::from(reader))
                .expect("registered TUN stand-in"),
        ),
        tunnel_ipv4: Ipv4Addr::new(100, 64, 0, 2),
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

#[tokio::test(flavor = "current_thread")]
async fn packet_path_probe_requires_a_correlated_egress_reply() {
    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("test Egress UDP");
    let endpoint = egress.local_addr().expect("Egress address");
    let responder = tokio::spawn(async move {
        let id =
            antnest_runtime_tunnel::KeyId::parse("rtk_0102030405060708090a0b0c0d0e0f10").unwrap();
        let mut crypto = antnest_runtime_tunnel::Peer::new(
            id,
            [29; 32],
            antnest_runtime_tunnel::Peer::public_key([11; 32]),
            [53; 32],
        );
        let mut packet = [0u8; antnest_runtime_tunnel::MAX_DATAGRAM + 1];
        loop {
            let (size, peer) = egress.recv_from(&mut packet).await.expect("probe");
            let Ok(events) = crypto.receive(&packet[..size], peer.ip()) else {
                return;
            };
            for event in events {
                match event {
                    antnest_runtime_tunnel::Event::Network(frame) => {
                        egress.send_to(&frame, peer).await.unwrap();
                    }
                    antnest_runtime_tunnel::Event::Ipv4(inner) => {
                        let reply = unsupported_ipv4_rejection(&inner).unwrap();
                        for output in crypto.send(&reply).unwrap() {
                            if let antnest_runtime_tunnel::Event::Network(frame) = output {
                                egress.send_to(&frame, peer).await.unwrap();
                            }
                        }
                        return;
                    }
                }
            }
        }
    });
    let socket = connect_management_udp(endpoint).expect("connected UDP");

    verify_egress_path(
        &socket,
        &mut crate::tunnel_auth::decode(
            &crate::tunnel_auth_tests::fixture().1,
            &crate::tunnel_auth_tests::fixture().0,
        )
        .unwrap(),
        Ipv4Addr::new(100, 64, 0, 2),
        1,
        1,
        std::time::Duration::from_millis(200),
    )
    .await
    .expect("matching response proves path");
    responder.await.expect("responder task");
}

#[tokio::test(flavor = "current_thread")]
async fn packet_path_probe_retries_lost_handshake_without_raw_fallback() {
    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("test Egress UDP");
    let endpoint = egress.local_addr().expect("Egress address");
    let responder = tokio::spawn(async move {
        let id =
            antnest_runtime_tunnel::KeyId::parse("rtk_0102030405060708090a0b0c0d0e0f10").unwrap();
        let mut crypto = antnest_runtime_tunnel::Peer::new(
            id,
            [29; 32],
            antnest_runtime_tunnel::Peer::public_key([11; 32]),
            [53; 32],
        );
        let mut packet = [0u8; antnest_runtime_tunnel::MAX_DATAGRAM + 1];
        let (size, _) = egress
            .recv_from(&mut packet)
            .await
            .expect("first handshake");
        assert!(size > 20 && &packet[..4] == b"ANT2");
        // Drop the first authenticated handshake; the real engine must retry.
        loop {
            let (size, peer) = egress.recv_from(&mut packet).await.expect("probe");
            let Ok(events) = crypto.receive(&packet[..size], peer.ip()) else {
                return;
            };
            for event in events {
                match event {
                    antnest_runtime_tunnel::Event::Network(frame) => {
                        egress.send_to(&frame, peer).await.unwrap();
                    }
                    antnest_runtime_tunnel::Event::Ipv4(inner) => {
                        let reply = unsupported_ipv4_rejection(&inner).unwrap();
                        for output in crypto.send(&reply).unwrap() {
                            if let antnest_runtime_tunnel::Event::Network(frame) = output {
                                egress.send_to(&frame, peer).await.unwrap();
                            }
                        }
                        return;
                    }
                }
            }
        }
    });
    let socket = connect_management_udp(endpoint).expect("connected UDP");

    verify_egress_path(
        &socket,
        &mut crate::tunnel_auth::decode(
            &crate::tunnel_auth_tests::fixture().1,
            &crate::tunnel_auth_tests::fixture().0,
        )
        .unwrap(),
        Ipv4Addr::new(100, 64, 0, 2),
        1,
        3,
        std::time::Duration::from_secs(3),
    )
    .await
    .expect("matching response proves path");
    responder.await.expect("responder task");
}

#[tokio::test(flavor = "current_thread")]
async fn packet_path_probe_fails_closed_when_egress_does_not_reply() {
    let silent = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("silent Egress UDP");
    let socket = connect_management_udp(silent.local_addr().unwrap()).unwrap();

    let error = verify_egress_path(
        &socket,
        &mut crate::tunnel_auth::decode(
            &crate::tunnel_auth_tests::fixture().1,
            &crate::tunnel_auth_tests::fixture().0,
        )
        .unwrap(),
        Ipv4Addr::new(100, 64, 0, 2),
        1,
        1,
        std::time::Duration::from_millis(20),
    )
    .await
    .expect_err("silence must fail readiness");

    assert!(error.to_string().contains("readiness probe timed out"));
}

fn loopback_network(endpoint: std::net::SocketAddr) -> (UdpNetwork, tokio::net::UnixDatagram) {
    let (tun, client) = std::os::unix::net::UnixDatagram::pair().unwrap();
    tun.set_nonblocking(true).unwrap();
    client.set_nonblocking(true).unwrap();
    let (descriptor, raw) = crate::tunnel_auth_tests::fixture();
    let network = UdpNetwork::connect(
        endpoint,
        1400,
        std::fs::File::from(std::os::fd::OwnedFd::from(tun)),
        Ipv4Addr::new(100, 64, 0, 2),
        crate::tunnel_auth::decode(&raw, &descriptor).unwrap(),
    )
    .unwrap();
    (network, tokio::net::UnixDatagram::from_std(client).unwrap())
}

fn loopback_egress_peer() -> antnest_runtime_tunnel::Peer {
    antnest_runtime_tunnel::Peer::new(
        antnest_runtime_tunnel::KeyId::parse("rtk_0102030405060708090a0b0c0d0e0f10").unwrap(),
        [29; 32],
        antnest_runtime_tunnel::Peer::public_key([11; 32]),
        [53; 32],
    )
}

async fn reply_to_loopback_probe(
    socket: &tokio::net::UdpSocket,
    crypto: &mut antnest_runtime_tunnel::Peer,
) -> Vec<u8> {
    let mut packet = [0; antnest_runtime_tunnel::MAX_DATAGRAM + 1];
    loop {
        let (size, address) = socket.recv_from(&mut packet).await.unwrap();
        for event in crypto.receive(&packet[..size], address.ip()).unwrap() {
            match event {
                antnest_runtime_tunnel::Event::Network(frame) => {
                    socket.send_to(&frame, address).await.unwrap();
                }
                antnest_runtime_tunnel::Event::Ipv4(inner) => {
                    let reply = unsupported_ipv4_rejection(&inner).unwrap();
                    for event in crypto.send(&reply).unwrap() {
                        if let antnest_runtime_tunnel::Event::Network(frame) = event {
                            socket.send_to(&frame, address).await.unwrap();
                        }
                    }
                    return inner;
                }
            }
        }
    }
}

async fn warm_loopback_network(
    network: &mut UdpNetwork,
    egress: &tokio::net::UdpSocket,
    crypto: &mut antnest_runtime_tunnel::Peer,
) {
    let (ready, reply) = tokio::join!(
        verify_egress_path(
            &network.socket,
            &mut network.peer,
            network.tunnel_ipv4,
            1,
            1,
            std::time::Duration::from_secs(1),
        ),
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            reply_to_loopback_probe(egress, crypto),
        ),
    );
    ready.expect("warm authenticated session");
    reply.expect("warm peer reply");
}

#[tokio::test(flavor = "current_thread")]
async fn established_session_survives_refused_receive_and_recovers_on_same_port() {
    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let endpoint = egress.local_addr().unwrap();
    let (mut network, tun) = loopback_network(endpoint);
    let mut crypto = loopback_egress_peer();
    warm_loopback_network(&mut network, &egress, &mut crypto).await;
    drop(egress);

    let probe = crate::packet::egress_readiness_probe(network.tunnel_ipv4, 12345, 6);
    for event in network.peer.send(&probe).unwrap() {
        if let antnest_runtime_tunnel::Event::Network(frame) = event {
            network.socket.send(&frame).await.unwrap();
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let shutdown = CancellationToken::new();
    let session = network.run(shutdown.clone(), RuntimeMetrics::default());
    tokio::pin!(session);
    let recovery = async {
        tokio::time::sleep(std::time::Duration::from_millis(
            2 * antnest_runtime_tunnel::TIMER_MILLIS,
        ))
        .await;
        let egress = tokio::net::UdpSocket::bind(endpoint).await.unwrap();
        let probe = crate::packet::egress_readiness_probe(Ipv4Addr::new(100, 64, 0, 2), 12345, 7);
        tun.send(&probe).await.unwrap();
        assert_eq!(reply_to_loopback_probe(&egress, &mut crypto).await, probe);
        let mut reply = [0; 1400];
        let size = tun.recv(&mut reply).await.unwrap();
        assert_eq!(&reply[..size], unsupported_ipv4_rejection(&probe).unwrap());
    };
    tokio::select! {
        result = &mut session => panic!("session ended during peer outage: {result:?}"),
        result = tokio::time::timeout(std::time::Duration::from_secs(2), recovery) => {
            result.expect("traffic resumes after peer returns");
        }
    }
    shutdown.cancel();
    session.await.expect("session stops cleanly after recovery");
}

#[tokio::test(flavor = "current_thread")]
async fn established_session_survives_tun_traffic_during_peer_outage() {
    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let endpoint = egress.local_addr().unwrap();
    let (mut network, tun) = loopback_network(endpoint);
    let mut crypto = loopback_egress_peer();
    warm_loopback_network(&mut network, &egress, &mut crypto).await;
    let probe = crate::packet::egress_readiness_probe(network.tunnel_ipv4, 12345, 7);
    let shutdown = CancellationToken::new();
    let session = network.run(shutdown.clone(), RuntimeMetrics::default());
    tokio::pin!(session);
    let recovery = async {
        tun.send(&probe).await.unwrap();
        assert_eq!(reply_to_loopback_probe(&egress, &mut crypto).await, probe);
        let mut reply = [0; 1400];
        let size = tun.recv(&mut reply).await.unwrap();
        assert_eq!(&reply[..size], unsupported_ipv4_rejection(&probe).unwrap());
        drop(egress);

        tun.send(&probe).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        tun.send(&probe).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(
            2 * antnest_runtime_tunnel::TIMER_MILLIS,
        ))
        .await;

        let egress = tokio::net::UdpSocket::bind(endpoint).await.unwrap();
        tun.send(&probe).await.unwrap();
        assert_eq!(reply_to_loopback_probe(&egress, &mut crypto).await, probe);
        let size = tun.recv(&mut reply).await.unwrap();
        assert_eq!(&reply[..size], unsupported_ipv4_rejection(&probe).unwrap());
    };
    tokio::select! {
        result = &mut session => panic!("live session ended during peer outage: {result:?}"),
        result = tokio::time::timeout(std::time::Duration::from_secs(2), recovery) => {
            result.expect("live TUN traffic resumes after peer returns");
        }
    }
    shutdown.cancel();
    session
        .await
        .expect("live session stops cleanly after recovery");
}

#[tokio::test(flavor = "current_thread")]
async fn established_session_keeps_other_send_errors_fatal() {
    use std::os::fd::AsRawFd as _;

    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let (mut network, tun) = loopback_network(egress.local_addr().unwrap());
    let mut crypto = loopback_egress_peer();
    warm_loopback_network(&mut network, &egress, &mut crypto).await;
    assert_eq!(
        unsafe { libc::shutdown(network.socket.as_raw_fd(), libc::SHUT_WR) },
        0
    );
    tun.send(&crate::packet::egress_readiness_probe(
        network.tunnel_ipv4,
        12345,
        7,
    ))
    .await
    .unwrap();

    let error = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        network.run(CancellationToken::new(), RuntimeMetrics::default()),
    )
    .await
    .expect("write-shutdown UDP socket fails promptly")
    .expect_err("non-refusal send error must end the session");
    assert_eq!(error.code().as_str(), "network_transport_failed");
    assert!(error.to_string().contains("Broken pipe"));
}

#[tokio::test(flavor = "current_thread")]
async fn established_session_drops_refused_sends_without_retrying() {
    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let endpoint = egress.local_addr().unwrap();
    let socket = connect_management_udp(endpoint).unwrap();
    drop(egress);
    socket.send(b"closed peer").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let mut metrics = NetworkMetrics::new(RuntimeMetrics::default());
    send_network_events(
        &socket,
        vec![antnest_runtime_tunnel::Event::Network(b"dropped".to_vec())],
        &mut metrics,
    )
    .await
    .expect("refused established-session send is packet loss");
    assert_eq!(metrics.connection_refused, 1);

    let egress = tokio::net::UdpSocket::bind(endpoint).await.unwrap();
    send_network_events(
        &socket,
        vec![antnest_runtime_tunnel::Event::Network(b"resumed".to_vec())],
        &mut metrics,
    )
    .await
    .unwrap();
    let mut reply = [0; 32];
    let (size, _) = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        egress.recv_from(&mut reply),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(&reply[..size], b"resumed");
    assert_eq!(metrics.connection_refused, 1);
    assert_eq!(
        egress.try_recv_from(&mut reply).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test(flavor = "current_thread")]
async fn packet_path_probe_keeps_connection_refused_fail_closed() {
    let egress = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let socket = connect_management_udp(egress.local_addr().unwrap()).unwrap();
    drop(egress);
    socket.send(b"closed peer").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let (descriptor, raw) = crate::tunnel_auth_tests::fixture();
    let mut peer = crate::tunnel_auth::decode(&raw, &descriptor).unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_millis(200),
        verify_egress_path(
            &socket,
            &mut peer,
            Ipv4Addr::new(100, 64, 0, 2),
            1,
            3,
            std::time::Duration::from_secs(3),
        ),
    )
    .await
    .expect("readiness refusal fails immediately within the existing budget")
    .expect_err("refusal cannot prove readiness");
    assert_eq!(error.code().as_str(), "network_transport_failed");
    assert!(error.to_string().contains("Connection refused"));
}
