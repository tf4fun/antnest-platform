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
