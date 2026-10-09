use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use antnest_runtime_egress::{
    dns::{DnsMetrics, DnsProxyConfig, run_dns_proxy},
    policy::PROTECTED_IPV4_NETWORKS,
};
use hickory_proto::{
    op::{Message, MessageType, OpCode, Query, ResponseCode},
    rr::{
        Name, RData, Record, RecordType,
        rdata::{A, CNAME, PTR},
    },
    serialize::binary::{BinDecodable, BinEncodable},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const DEADLINE: Duration = Duration::from_secs(2);

fn query(id: u16, name: &str, record_type: RecordType) -> Message {
    let mut query = Message::new(id, MessageType::Query, OpCode::Query);
    query.metadata.recursion_desired = true;
    query.add_query(Query::query(Name::from_ascii(name).unwrap(), record_type));
    query
}

fn answer(query: &Message, records: Vec<Record>) -> Message {
    let mut response = query.clone().into_response();
    response.metadata.recursion_available = true;
    response.add_answers(records);
    response
}

fn record(name: &str, data: RData) -> Record {
    Record::from_rdata(Name::from_ascii(name).unwrap(), 60, data)
}

fn a(name: &str, address: &str) -> Record {
    record(name, RData::A(A(address.parse::<Ipv4Addr>().unwrap())))
}

fn cname(name: &str, target: &str) -> Record {
    record(name, RData::CNAME(CNAME(Name::from_ascii(target).unwrap())))
}

fn frame(bytes: &[u8]) -> Vec<u8> {
    let mut wire = u16::try_from(bytes.len()).unwrap().to_be_bytes().to_vec();
    wire.extend_from_slice(bytes);
    wire
}

async fn read_frame(stream: &mut TcpStream) -> Vec<u8> {
    let length = stream.read_u16().await.unwrap();
    let mut bytes = vec![0; usize::from(length)];
    stream.read_exact(&mut bytes).await.unwrap();
    bytes
}

struct Proxy {
    address: std::net::SocketAddr,
    metrics: Arc<DnsMetrics>,
    cancellation: CancellationToken,
    proxy: JoinHandle<()>,
    upstream: JoinHandle<()>,
}

impl Proxy {
    async fn start(replies: Vec<(Message, Vec<u8>)>, per_source: usize) -> Self {
        Self::with_networks(replies, per_source, Vec::new()).await
    }

    async fn with_networks(
        replies: Vec<(Message, Vec<u8>)>,
        per_source: usize,
        networks: Vec<ipnet::Ipv4Net>,
    ) -> Self {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let upstream_task = tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            for (expected, reply) in replies {
                assert_eq!(
                    Message::from_bytes(&read_frame(&mut stream).await).unwrap(),
                    expected
                );
                stream.write_all(&reply).await.unwrap();
            }
            stream.shutdown().await.unwrap();
            let mut unexpected = Vec::new();
            stream.read_to_end(&mut unexpected).await.unwrap();
            assert!(
                unexpected.is_empty(),
                "unexpected upstream query: {unexpected:?}"
            );
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancellation = CancellationToken::new();
        let metrics = Arc::new(DnsMetrics::default());
        let proxy_metrics = metrics.clone();
        let proxy_cancellation = cancellation.clone();
        let proxy = tokio::spawn(async move {
            run_dns_proxy(
                listener,
                DnsProxyConfig {
                    upstream: upstream_address,
                    protected_networks: networks,
                    max_connections: 4,
                    max_connections_per_source: per_source,
                    connection_timeout: DEADLINE,
                },
                proxy_metrics,
                proxy_cancellation,
            )
            .await
            .unwrap();
        });
        Self {
            address,
            metrics,
            cancellation,
            proxy,
            upstream: upstream_task,
        }
    }

    async fn exchange(&self, client: &mut TcpStream, query: &Message) -> Message {
        timeout(DEADLINE, async {
            client
                .write_all(&frame(&query.to_bytes().unwrap()))
                .await
                .unwrap();
            Message::from_bytes(&read_frame(client).await).unwrap()
        })
        .await
        .unwrap()
    }

    async fn finish(&mut self) {
        timeout(DEADLINE, &mut self.upstream)
            .await
            .unwrap()
            .unwrap();
        timeout(DEADLINE, async {
            while self.metrics.snapshot().completed_connections == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        self.cancellation.cancel();
        timeout(DEADLINE, &mut self.proxy).await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn every_protected_policy_range_is_filtered() {
    let query = query(47, "blocked.example.", RecordType::A);
    let records = PROTECTED_IPV4_NETWORKS
        .iter()
        .map(|network| record("blocked.example.", RData::A(A(network.network()))))
        .collect();
    let response = answer(&query, records);
    let proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    assert!(proxy.exchange(&mut client, &query).await.answers.is_empty());
}

#[tokio::test]
async fn connected_subnets_and_custom_tunnel_pool_are_filtered() {
    let query = query(48, "connected.example.", RecordType::A);
    let public = a("connected.example.", "93.184.216.34");
    let response = answer(
        &query,
        vec![
            a("connected.example.", "8.8.8.2"),
            a("connected.example.", "9.9.9.2"),
            public.clone(),
        ],
    );
    let proxy = Proxy::with_networks(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
        vec!["8.8.8.0/24".parse().unwrap(), "9.9.9.0/24".parse().unwrap()],
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    assert_eq!(proxy.exchange(&mut client, &query).await.answers, [public]);
}

#[tokio::test]
async fn ancillary_records_and_authentic_data_are_not_exposed_after_filtering() {
    let query = query(49, "example.com.", RecordType::A);
    let public = a("example.com.", "93.184.216.34");
    let mut response = answer(
        &query,
        vec![public.clone(), a("example.com.", "10.241.0.2")],
    );
    response.metadata.authentic_data = true;
    response.add_additional(a("postgres.internal.", "10.241.0.2"));
    response.add_authority(cname("internal.example.", "postgres.internal."));
    let proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let filtered = proxy.exchange(&mut client, &query).await;
    assert_eq!(filtered.answers, [public]);
    assert!(filtered.additionals.is_empty());
    assert!(filtered.authorities.is_empty());
    assert!(!filtered.metadata.authentic_data);
}

#[tokio::test]
async fn mismatched_upstream_response_id_is_rejected() {
    let query = query(50, "example.com.", RecordType::A);
    let mut response = answer(&query, vec![a("example.com.", "93.184.216.34")]);
    response.metadata.id += 1;
    assert_upstream_rejected(query, frame(&response.to_bytes().unwrap())).await;
}

#[tokio::test]
async fn mismatched_upstream_question_is_rejected() {
    let query = query(51, "example.com.", RecordType::A);
    let mut response = answer(&query, vec![a("example.com.", "93.184.216.34")]);
    response.queries[0].name = Name::from_ascii("postgres.internal.").unwrap();
    assert_upstream_rejected(query, frame(&response.to_bytes().unwrap())).await;
}

#[tokio::test]
async fn trailing_upstream_bytes_inside_frame_are_rejected() {
    let query = query(52, "example.com.", RecordType::A);
    let response = answer(&query, vec![a("example.com.", "93.184.216.34")]);
    let mut bytes = response.to_bytes().unwrap();
    bytes.push(0);
    assert_upstream_rejected(query, frame(&bytes)).await;
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.proxy.abort();
        self.upstream.abort();
    }
}

#[tokio::test]
async fn private_a_records_are_removed_and_public_a_records_are_kept() {
    let query = query(36, "mixed.example.", RecordType::A);
    let public = a("mixed.example.", "93.184.216.34");
    let response = answer(
        &query,
        vec![a("mixed.example.", "10.241.0.2"), public.clone()],
    );
    let mut proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let response = proxy.exchange(&mut client, &query).await;
    assert_eq!(response.answers, [public]);
    assert_eq!(response.metadata.id, query.metadata.id);
    assert_eq!(response.queries, query.queries);
    assert_eq!(proxy.metrics.snapshot().filtered_answers, 1);
    drop(client);
    proxy.finish().await;
}

#[tokio::test]
async fn private_cname_chain_returns_nxdomain_without_internal_targets() {
    let query = query(37, "alias.example.", RecordType::A);
    let mut response = answer(
        &query,
        vec![
            cname("alias.example.", "internal.example."),
            cname("internal.example.", "postgres.internal."),
            a("postgres.internal.", "172.30.255.2"),
        ],
    );
    response.add_additional(a("postgres.internal.", "172.30.255.2"));
    response.add_authority(cname("internal.example.", "postgres.internal."));
    let proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let response = proxy.exchange(&mut client, &query).await;
    assert_eq!(response.metadata.response_code, ResponseCode::NXDomain);
    assert_eq!(response.metadata.message_type, MessageType::Response);
    assert_eq!(response.metadata.id, query.metadata.id);
    assert_eq!(response.queries, query.queries);
    assert!(response.answers.is_empty());
    assert!(response.authorities.is_empty());
    assert!(response.additionals.is_empty());
}

#[tokio::test]
async fn public_cname_chain_is_kept() {
    let query = query(38, "alias.example.", RecordType::A);
    let response = answer(
        &query,
        vec![
            cname("alias.example.", "public.example."),
            cname("public.example.", "final.example."),
            a("final.example.", "93.184.216.34"),
        ],
    );
    let proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    assert_eq!(
        proxy.exchange(&mut client, &query).await.answers,
        response.answers
    );
}

#[tokio::test]
async fn every_a_answer_removed_returns_nxdomain_with_original_question_and_id() {
    // An internal name must look exactly like a name that does not exist.
    let query = query(39, "postgres.", RecordType::A);
    let response = answer(
        &query,
        vec![a("postgres.", "10.241.0.2"), a("postgres.", "127.0.0.11")],
    );
    let proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let response = proxy.exchange(&mut client, &query).await;
    assert!(response.answers.is_empty());
    assert_eq!(response.metadata.response_code, ResponseCode::NXDomain);
    assert_eq!(response.metadata.message_type, MessageType::Response);
    assert_eq!(response.metadata.id, query.metadata.id);
    assert_eq!(response.queries, query.queries);
}

async fn assert_answered_locally(query: Message, response_code: ResponseCode) {
    let mut proxy = Proxy::start(Vec::new(), 2).await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let response = proxy.exchange(&mut client, &query).await;
    assert_eq!(response.metadata.message_type, MessageType::Response);
    assert_eq!(response.metadata.id, query.metadata.id);
    assert_eq!(response.metadata.response_code, response_code);
    assert_eq!(response.queries, query.queries);
    assert!(response.answers.is_empty());
    assert!(response.authorities.is_empty());
    assert!(response.additionals.is_empty());
    drop(client);
    proxy.finish().await;
}

#[tokio::test]
async fn aaaa_queries_get_nodata_without_reaching_the_upstream() {
    // Upstream AAAA answers would distinguish internal names (NODATA) from unknown ones (NXDOMAIN).
    assert_answered_locally(
        query(40, "postgres.", RecordType::AAAA),
        ResponseCode::NoError,
    )
    .await;
}

#[tokio::test]
async fn reverse_lookups_of_non_public_addresses_never_reach_the_upstream() {
    for (id, name, record_type) in [
        (41, "5.0.18.172.in-addr.arpa.", RecordType::PTR),
        (42, "2.0.241.10.IN-ADDR.ARPA.", RecordType::PTR),
        (43, "11.0.0.127.in-addr.arpa.", RecordType::PTR),
        (44, "2.0.64.100.in-addr.arpa.", RecordType::PTR),
        (45, "5.0.18.172.in-addr.arpa.", RecordType::TXT),
        (46, "18.172.in-addr.arpa.", RecordType::PTR),
        (47, "in-addr.arpa.", RecordType::PTR),
        (48, "01.1.1.1.in-addr.arpa.", RecordType::PTR),
        (49, "x.5.0.18.172.in-addr.arpa.", RecordType::PTR),
        (
            50,
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.d.f.ip6.arpa.",
            RecordType::PTR,
        ),
    ] {
        assert_answered_locally(query(id, name, record_type), ResponseCode::NXDomain).await;
    }
}

#[tokio::test]
async fn reverse_lookups_of_protected_public_networks_never_reach_the_upstream() {
    let query = query(51, "2.8.8.8.in-addr.arpa.", RecordType::PTR);
    let mut proxy = Proxy::with_networks(Vec::new(), 2, vec!["8.8.8.0/24".parse().unwrap()]).await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let response = proxy.exchange(&mut client, &query).await;
    assert_eq!(response.metadata.response_code, ResponseCode::NXDomain);
    assert!(response.answers.is_empty());
    drop(client);
    proxy.finish().await;
}

#[tokio::test]
async fn reverse_lookup_of_a_public_address_is_forwarded() {
    let query = query(52, "1.1.1.1.in-addr.arpa.", RecordType::PTR);
    let response = answer(
        &query,
        vec![record(
            "1.1.1.1.in-addr.arpa.",
            RData::PTR(PTR(Name::from_ascii("one.one.one.one.").unwrap())),
        )],
    );
    let mut proxy = Proxy::start(
        vec![(query.clone(), frame(&response.to_bytes().unwrap()))],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    assert_eq!(
        proxy.exchange(&mut client, &query).await.answers,
        response.answers
    );
    drop(client);
    proxy.finish().await;
}

async fn assert_upstream_rejected(query: Message, wire: Vec<u8>) {
    let proxy = Proxy::start(vec![(query.clone(), wire)], 2).await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    client
        .write_all(&frame(&query.to_bytes().unwrap()))
        .await
        .unwrap();
    let mut reply = Vec::new();
    let result = timeout(DEADLINE, client.read_to_end(&mut reply))
        .await
        .unwrap();
    assert!(
        reply.is_empty(),
        "invalid upstream bytes reached the client: {reply:?}"
    );
    if let Err(error) = result {
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
    }
    timeout(DEADLINE, async {
        while proxy.metrics.snapshot().proxy_failures == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn truncated_flag_in_upstream_response_closes_connection_without_forwarding() {
    let query = query(41, "example.com.", RecordType::A);
    let mut response = answer(&query, vec![a("example.com.", "93.184.216.34")]);
    response.metadata.truncation = true;
    assert_upstream_rejected(query, frame(&response.to_bytes().unwrap())).await;
}

#[tokio::test]
async fn malformed_upstream_response_closes_connection_without_forwarding() {
    assert_upstream_rejected(query(42, "example.com.", RecordType::A), frame(&[0, 42])).await;
}

#[tokio::test]
async fn incomplete_upstream_frame_closes_connection_without_forwarding() {
    let query = query(43, "example.com.", RecordType::A);
    let response = answer(&query, vec![a("example.com.", "93.184.216.34")]);
    let mut wire = frame(&response.to_bytes().unwrap());
    wire.truncate(wire.len() - 3);
    assert_upstream_rejected(query, wire).await;
}

#[tokio::test]
async fn oversized_upstream_frame_closes_connection_without_forwarding() {
    assert_upstream_rejected(
        query(44, "example.com.", RecordType::A),
        16_385_u16.to_be_bytes().to_vec(),
    )
    .await;
}

#[tokio::test]
async fn multiple_queries_on_one_tcp_connection_are_filtered_independently() {
    let private_query = query(45, "postgres.", RecordType::A);
    let public_query = query(46, "example.com.", RecordType::A);
    let private = answer(&private_query, vec![a("postgres.", "10.241.0.2")]);
    let public = answer(&public_query, vec![a("example.com.", "93.184.216.34")]);
    let mut proxy = Proxy::start(
        vec![
            (private_query.clone(), frame(&private.to_bytes().unwrap())),
            (public_query.clone(), frame(&public.to_bytes().unwrap())),
        ],
        2,
    )
    .await;
    let mut client = TcpStream::connect(proxy.address).await.unwrap();
    let filtered = proxy.exchange(&mut client, &private_query).await;
    assert!(filtered.answers.is_empty());
    assert_eq!(filtered.metadata.id, private_query.metadata.id);
    let allowed = proxy.exchange(&mut client, &public_query).await;
    assert_eq!(allowed.answers, public.answers);
    assert_eq!(allowed.metadata.id, public_query.metadata.id);
    drop(client);
    proxy.finish().await;
    let snapshot = proxy.metrics.snapshot();
    assert_eq!(snapshot.accepted_connections, 1);
    assert_eq!(snapshot.completed_connections, 1);
    assert_eq!(snapshot.proxy_failures, 0);
    assert_eq!(
        snapshot.client_to_upstream_bytes,
        (frame(&private_query.to_bytes().unwrap()).len()
            + frame(&public_query.to_bytes().unwrap()).len()) as u64
    );
    assert_eq!(
        snapshot.upstream_to_client_bytes,
        (frame(&filtered.to_bytes().unwrap()).len() + frame(&allowed.to_bytes().unwrap()).len())
            as u64
    );
}

#[tokio::test]
async fn per_source_connection_limit_still_rejects_excess_clients() {
    let proxy = Proxy::start(Vec::new(), 1).await;
    let first = TcpStream::connect(proxy.address).await.unwrap();
    timeout(DEADLINE, async {
        while proxy.metrics.snapshot().accepted_connections == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut excess = TcpStream::connect(proxy.address).await.unwrap();
    let mut reply = [0; 1];
    assert_eq!(
        timeout(DEADLINE, excess.read(&mut reply))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert_eq!(proxy.metrics.snapshot().rejected_connections, 1);
    drop(first);
}
