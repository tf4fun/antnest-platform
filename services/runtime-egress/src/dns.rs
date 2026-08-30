use std::{
    collections::HashMap,
    io,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use thiserror::Error;
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinSet,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DnsMetricsSnapshot {
    pub accepted_connections: u64,
    pub rejected_connections: u64,
    pub completed_connections: u64,
    pub proxy_failures: u64,
    pub client_to_upstream_bytes: u64,
    pub upstream_to_client_bytes: u64,
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

    fn completed(&self, client_to_upstream: u64, upstream_to_client: u64) {
        self.completed_connections.fetch_add(1, Ordering::Relaxed);
        self.client_to_upstream_bytes
            .fetch_add(client_to_upstream, Ordering::Relaxed);
        self.upstream_to_client_bytes
            .fetch_add(upstream_to_client, Ordering::Relaxed);
    }
}

pub async fn run_dns_proxy(
    listener: TcpListener,
    upstream: SocketAddr,
    max_connections: usize,
    max_connections_per_source: usize,
    connection_timeout: Duration,
    metrics: Arc<DnsMetrics>,
    cancellation: CancellationToken,
) -> Result<(), DnsError> {
    if max_connections == 0
        || max_connections_per_source == 0
        || max_connections_per_source > max_connections
    {
        return Err(DnsError::InvalidLimit);
    }
    let permits = Arc::new(Semaphore::new(max_connections));
    let source_limits = SourceLimits::new(max_connections_per_source);
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
                connections.spawn(async move {
                    let _permit = permit;
                    let _source_permit = source_permit;
                    match proxy_connection(client, upstream, connection_timeout).await {
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
) -> Result<(u64, u64), io::Error> {
    let mut server = timeout(deadline, TcpStream::connect(upstream))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "DNS upstream connect timeout"))??;
    timeout(deadline, copy_bidirectional(&mut client, &mut server))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "DNS proxy idle timeout"))?
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::SourceLimits;

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
