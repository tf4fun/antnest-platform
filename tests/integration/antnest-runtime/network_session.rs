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
        let mut packet = [0_u8; 1400];
        let (size, peer) = egress.recv_from(&mut packet).await.expect("probe");
        let reply = unsupported_ipv4_rejection(&packet[..size]).expect("probe reset");
        egress.send_to(&reply, peer).await.expect("probe response");
    });
    let socket = connect_management_udp(endpoint).expect("connected UDP");

    verify_egress_path(
        &socket,
        Ipv4Addr::new(100, 64, 0, 2),
        1400,
        1,
        1,
        std::time::Duration::from_millis(200),
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
        Ipv4Addr::new(100, 64, 0, 2),
        1400,
        1,
        1,
        std::time::Duration::from_millis(20),
    )
    .await
    .expect_err("silence must fail readiness");

    assert!(error.to_string().contains("readiness probe timed out"));
}
