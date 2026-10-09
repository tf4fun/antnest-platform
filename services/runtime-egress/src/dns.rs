use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use hickory_proto::{
    op::{Edns, Message, MessageType, Metadata, OpCode, ResponseCode},
    rr::{DNSClass, Name, RData, RecordType},
    serialize::binary::{BinDecodable, BinDecoder, BinEncodable},
};
use ipnet::{IpNet, Ipv4Net};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::policy::is_external_ipv4;

const MAX_MESSAGE_BYTES: usize = 16_384;

#[derive(Debug, Error)]
pub enum DnsError {
    #[error("DNS listener failed: {0}")]
    Listener(io::Error),
    #[error(
        "DNS proxy limits must be positive and the per-source limit must not exceed the global limit"
    )]
    InvalidLimit,
}

struct SourceLimits {
    maximum: usize,
    active: Mutex<HashMap<IpAddr, usize>>,
}

impl SourceLimits {
    fn new(maximum: usize) -> Arc<Self> {
        Arc::new(Self {
            maximum,
            active: Mutex::new(HashMap::new()),
        })
    }

    fn try_acquire(self: &Arc<Self>, source: IpAddr) -> Option<SourcePermit> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let count = active.entry(source).or_default();
        if *count >= self.maximum {
            return None;
        }
        *count += 1;
        Some(SourcePermit {
            limits: self.clone(),
            source,
        })
    }

    fn release(&self, source: IpAddr) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(count) = active.get_mut(&source) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            active.remove(&source);
        }
    }
}

struct SourcePermit {
    limits: Arc<SourceLimits>,
    source: IpAddr,
}

impl Drop for SourcePermit {
    fn drop(&mut self) {
        self.limits.release(self.source);
    }
}

#[derive(Default)]
pub struct DnsMetrics {
    accepted_connections: AtomicU64,
    rejected_connections: AtomicU64,
    completed_connections: AtomicU64,
    proxy_failures: AtomicU64,
    client_to_upstream_bytes: AtomicU64,
    upstream_to_client_bytes: AtomicU64,
    filtered_answers: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DnsMetricsSnapshot {
    pub accepted_connections: u64,
    pub rejected_connections: u64,
    pub completed_connections: u64,
    pub proxy_failures: u64,
    pub client_to_upstream_bytes: u64,
    pub upstream_to_client_bytes: u64,
    pub filtered_answers: u64,
}

impl DnsMetrics {
    pub fn snapshot(&self) -> DnsMetricsSnapshot {
        DnsMetricsSnapshot {
            accepted_connections: self.accepted_connections.load(Ordering::Relaxed),
            rejected_connections: self.rejected_connections.load(Ordering::Relaxed),
            completed_connections: self.completed_connections.load(Ordering::Relaxed),
            proxy_failures: self.proxy_failures.load(Ordering::Relaxed),
            client_to_upstream_bytes: self.client_to_upstream_bytes.load(Ordering::Relaxed),
            upstream_to_client_bytes: self.upstream_to_client_bytes.load(Ordering::Relaxed),
            filtered_answers: self.filtered_answers.load(Ordering::Relaxed),
        }
    }

    fn accepted(&self) {
        self.accepted_connections.fetch_add(1, Ordering::Relaxed);
    }

    fn rejected(&self) {
        self.rejected_connections.fetch_add(1, Ordering::Relaxed);
    }

    fn failed(&self) {
        self.proxy_failures.fetch_add(1, Ordering::Relaxed);
    }

    fn filtered(&self, count: usize) {
        self.filtered_answers
            .fetch_add(count as u64, Ordering::Relaxed);
    }

    fn completed(&self, client_to_upstream: u64, upstream_to_client: u64) {
        self.completed_connections.fetch_add(1, Ordering::Relaxed);
        self.client_to_upstream_bytes
            .fetch_add(client_to_upstream, Ordering::Relaxed);
        self.upstream_to_client_bytes
            .fetch_add(upstream_to_client, Ordering::Relaxed);
    }
}

pub struct DnsProxyConfig {
    pub upstream: SocketAddr,
    pub protected_networks: Vec<Ipv4Net>,
    pub max_connections: usize,
    pub max_connections_per_source: usize,
    pub connection_timeout: Duration,
}

pub async fn run_dns_proxy(
    listener: TcpListener,
    config: DnsProxyConfig,
    metrics: Arc<DnsMetrics>,
    cancellation: CancellationToken,
) -> Result<(), DnsError> {
    let DnsProxyConfig {
        upstream,
        protected_networks,
        max_connections,
        max_connections_per_source,
        connection_timeout,
    } = config;
    if max_connections == 0
        || max_connections_per_source == 0
        || max_connections_per_source > max_connections
    {
        return Err(DnsError::InvalidLimit);
    }
    let permits = Arc::new(Semaphore::new(max_connections));
    let source_limits = SourceLimits::new(max_connections_per_source);
    let protected_networks: Arc<[Ipv4Net]> = protected_networks.into();
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            () = cancellation.cancelled() => break,
            accepted = listener.accept() => {
                let (client, peer) = accepted.map_err(DnsError::Listener)?;
                metrics.accepted();
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    metrics.rejected();
                    continue;
                };
                let Some(source_permit) = source_limits.try_acquire(peer.ip()) else {
                    metrics.rejected();
                    continue;
                };
                let connection_metrics = metrics.clone();
                let protected_networks = protected_networks.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    let _source_permit = source_permit;
                    match proxy_connection(
                        client, upstream, connection_timeout, &protected_networks, &connection_metrics,
                    ).await {
                        Ok((client_to_upstream, upstream_to_client)) => {
                            connection_metrics.completed(client_to_upstream, upstream_to_client);
                        }
                        Err(_) => connection_metrics.failed(),
                    }
                });
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                if let Err(error) = result {
                    tracing::warn!(%error, "DNS proxy task failed");
                }
            }
        }
    }

    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

async fn proxy_connection(
    mut client: TcpStream,
    upstream: SocketAddr,
    deadline: Duration,
    protected: &[Ipv4Net],
    metrics: &DnsMetrics,
) -> Result<(u64, u64), io::Error> {
    let mut server = timeout(deadline, TcpStream::connect(upstream))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "DNS upstream connect timeout"))??;
    timeout(
        deadline,
        forward_queries(&mut client, &mut server, protected, metrics),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "DNS proxy connection timeout"))?
}

async fn forward_queries(
    client: &mut TcpStream,
    server: &mut TcpStream,
    protected: &[Ipv4Net],
    metrics: &DnsMetrics,
) -> io::Result<(u64, u64)> {
    let mut client_bytes = 0;
    let mut upstream_bytes = 0;
    while let Some(bytes) = read_frame(client).await? {
        let query = parse_message(&bytes)?;
        if query.metadata.message_type != MessageType::Query
            || query.metadata.op_code != OpCode::Query
            || query.queries.len() != 1
            || query.queries[0].query_class != DNSClass::IN
            || matches!(
                query.queries[0].query_type,
                RecordType::AXFR | RecordType::IXFR
            )
            || query.signature.is_some()
        {
            return Err(invalid_message());
        }
        if let Some(response) = local_response(&query, protected) {
            let bytes = response.to_bytes().map_err(|_| invalid_message())?;
            write_frame(client, &bytes).await?;
            continue;
        }
        write_frame(server, &bytes).await?;
        client_bytes += (bytes.len() + 2) as u64;
        let bytes = read_frame(server).await?.ok_or_else(invalid_message)?;
        let response = parse_message(&bytes)?;
        if response.metadata.message_type != MessageType::Response
            || response.metadata.op_code != query.metadata.op_code
            || response.metadata.id != query.metadata.id
            || response.queries != query.queries
            || response.metadata.truncation
            || response.signature.is_some()
        {
            return Err(invalid_message());
        }
        let (response, removed) = filter_response(&query, response, protected);
        let bytes = response.to_bytes().map_err(|_| invalid_message())?;
        metrics.filtered(removed);
        write_frame(client, &bytes).await?;
        upstream_bytes += (bytes.len() + 2) as u64;
    }
    Ok((client_bytes, upstream_bytes))
}

async fn read_frame(stream: &mut TcpStream) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0; 2];
    if stream.read(&mut prefix[..1]).await? == 0 {
        return Ok(None);
    }
    stream.read_exact(&mut prefix[1..]).await?;
    let length = usize::from(u16::from_be_bytes(prefix));
    if !(12..=MAX_MESSAGE_BYTES).contains(&length) {
        return Err(invalid_message());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(Some(bytes))
}

async fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(invalid_message());
    }
    stream
        .write_all(&(bytes.len() as u16).to_be_bytes())
        .await?;
    stream.write_all(bytes).await
}

fn parse_message(bytes: &[u8]) -> io::Result<Message> {
    let mut decoder = BinDecoder::new(bytes);
    let message = Message::read(&mut decoder).map_err(|_| invalid_message())?;
    if !decoder.is_empty() {
        return Err(invalid_message());
    }
    Ok(message)
}

/// Answers queries whose upstream reply could reveal internal names without forwarding them.
fn local_response(query: &Message, protected: &[Ipv4Net]) -> Option<Message> {
    let question = &query.queries[0];
    // Docker's embedded resolver answers internal names with NODATA for AAAA and owns the
    // reverse zones of every network Egress joins.
    let response_code = if question.query_type == RecordType::AAAA {
        ResponseCode::NoError
    } else if is_reverse_name(&question.name) && !is_public_reverse_name(&question.name, protected)
    {
        ResponseCode::NXDomain
    } else {
        return None;
    };
    let mut response = Message::new(query.metadata.id, MessageType::Response, OpCode::Query);
    response.metadata = Metadata::response_from_request(&query.metadata);
    response.metadata.recursion_available = true;
    response.metadata.response_code = response_code;
    response.queries.clone_from(&query.queries);
    response.edns = query.edns.as_ref().map(|_| Edns::new());
    Some(response)
}

fn is_reverse_name(name: &Name) -> bool {
    ["in-addr.arpa.", "ip6.arpa."].iter().any(|zone| {
        Name::from_ascii(zone)
            .expect("reverse zone names are valid")
            .zone_of(name)
    })
}

fn is_public_reverse_name(name: &Name, protected: &[Ipv4Net]) -> bool {
    let Ok(IpNet::V4(network)) = name.parse_arpa_name() else {
        return false;
    };
    let address = network.addr();
    let [a, b, c, d] = address.octets();
    // Only the canonical form is forwarded, so no resolver can read the labels differently.
    network.prefix_len() == 32
        && name
            .to_ascii()
            .eq_ignore_ascii_case(&format!("{d}.{c}.{b}.{a}.in-addr.arpa."))
        && is_external_ipv4(address)
        && !protected.iter().any(|network| network.contains(&address))
}

fn invalid_message() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid DNS message")
}

fn filter_response(
    query: &Message,
    mut response: Message,
    protected: &[Ipv4Net],
) -> (Message, usize) {
    let original_answers = response.answers.len();
    let mut blocked_names: HashSet<_> = response
        .answers
        .iter()
        .filter(|record| matches!(record.data, RData::A(_) | RData::AAAA(_)))
        .map(|record| record.name.clone())
        .collect();
    response.answers.retain(|record| match &record.data {
        RData::A(address) => {
            is_external_ipv4(address.0)
                && !protected.iter().any(|network| network.contains(&address.0))
        }
        RData::AAAA(_) => false,
        _ => !record.record_type().is_dnssec(),
    });
    for record in &response.answers {
        if matches!(record.data, RData::A(_)) {
            blocked_names.remove(&record.name);
        }
    }
    // Other records must not expose a terminal whose entire address set was denied.
    response
        .answers
        .retain(|record| !blocked_names.contains(&record.name));
    let mut usable = HashSet::new();
    let mut aliases: HashMap<_, Vec<_>> = HashMap::new();
    for record in &response.answers {
        if let RData::CNAME(target) = &record.data {
            aliases
                .entry(target.0.clone())
                .or_default()
                .push(record.name.clone());
        } else {
            usable.insert(record.name.clone());
        }
    }
    let mut pending: VecDeque<_> = usable.iter().cloned().collect();
    while let Some(target) = pending.pop_front() {
        if let Some(owners) = aliases.remove(&target) {
            for owner in owners {
                if usable.insert(owner.clone()) {
                    pending.push_back(owner);
                }
            }
        }
    }
    response.answers.retain(|record| match &record.data {
        RData::CNAME(target) => usable.contains(&target.0),
        _ => true,
    });
    let removed = original_answers - response.answers.len();
    if removed != 0 {
        response.metadata.authoritative = false;
        if response.answers.is_empty() {
            // Matches the upstream reply for a name that does not exist at all.
            response.metadata.response_code = ResponseCode::NXDomain;
        }
    }
    response.queries.clone_from(&query.queries);
    response.metadata.authentic_data = false;
    // Ancillary records and EDNS options can disclose names even after A records are removed.
    response.authorities.clear();
    response.additionals.clear();
    response.edns = query.edns.as_ref().map(|_| Edns::new());
    (response, removed)
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::{SourceLimits, filter_response};
    use hickory_proto::{
        op::{Message, MessageType, OpCode, Query},
        rr::{
            Name, RData, Record, RecordType,
            rdata::{A, CNAME, TXT},
        },
    };

    #[test]
    fn private_cname_terminal_cannot_survive_as_an_extra_txt_record() {
        let alias = Name::from_ascii("alias.example.").unwrap();
        let internal = Name::from_ascii("postgres.internal.").unwrap();
        let mut query = Message::new(36, MessageType::Query, OpCode::Query);
        query.add_query(Query::query(alias.clone(), RecordType::A));
        let mut response = query.clone().into_response();
        response.add_answers([
            Record::from_rdata(alias, 60, RData::CNAME(CNAME(internal.clone()))),
            Record::from_rdata(
                internal.clone(),
                60,
                RData::A(A(Ipv4Addr::new(10, 0, 0, 1))),
            ),
            Record::from_rdata(
                internal,
                60,
                RData::TXT(TXT::new(vec!["metadata".to_owned()])),
            ),
        ]);
        let (filtered, removed) = filter_response(&query, response, &[]);
        assert!(filtered.answers.is_empty());
        assert_eq!(removed, 3);
    }

    #[test]
    fn cname_pruning_removes_cycles_and_dangling_private_branches() {
        let name = |value: &str| Name::from_ascii(value).unwrap();
        let cname = |owner: &str, target: &str| {
            Record::from_rdata(name(owner), 60, RData::CNAME(CNAME(name(target))))
        };
        let mut query = Message::new(36, MessageType::Query, OpCode::Query);
        query.add_query(Query::query(name("alias.example."), RecordType::A));
        let public = Record::from_rdata(
            name("public.example."),
            60,
            RData::A(A(Ipv4Addr::new(93, 184, 216, 34))),
        );
        let alias = cname("alias.example.", "public.example.");
        let mut response = query.clone().into_response();
        response.add_answers([
            alias.clone(),
            public.clone(),
            cname("cycle-a.example.", "cycle-b.example."),
            cname("cycle-b.example.", "cycle-a.example."),
            cname("dead.example.", "postgres.internal."),
            Record::from_rdata(
                name("postgres.internal."),
                60,
                RData::A(A(Ipv4Addr::new(10, 0, 0, 1))),
            ),
        ]);
        let (filtered, removed) = filter_response(&query, response, &[]);
        assert_eq!(filtered.answers, [alias, public]);
        assert_eq!(removed, 4);
    }

    #[test]
    fn source_limit_is_fair_and_releases_capacity_on_drop() {
        let limits = SourceLimits::new(1);
        let first = limits.try_acquire(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 2)));
        assert!(first.is_some());
        assert!(
            limits
                .try_acquire(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 2)))
                .is_none()
        );

        let other = limits.try_acquire(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 3)));
        assert!(other.is_some());

        drop(first);
        assert!(
            limits
                .try_acquire(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 2)))
                .is_some()
        );
    }
}
