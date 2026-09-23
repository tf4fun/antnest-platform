use std::{sync::Arc, time::Duration};

use antnest_runtime_egress::dns::{DnsMetrics, run_dns_proxy};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn dns_proxy_forwards_the_tcp_byte_stream_to_configured_upstream() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream.accept().await.unwrap();
        let mut bytes = [0_u8; 5];
        stream.read_exact(&mut bytes).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = listener.local_addr().unwrap();
    let cancellation = CancellationToken::new();
    let metrics = Arc::new(DnsMetrics::default());
    let proxy_task = tokio::spawn(run_dns_proxy(
        listener,
        upstream_address,
        4,
        2,
        Duration::from_secs(1),
        metrics.clone(),
        cancellation.clone(),
    ));

    let mut client = TcpStream::connect(proxy_address).await.unwrap();
    client.write_all(b"query").await.unwrap();
    let mut reply = [0_u8; 5];
    client.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"query");

    drop(client);
    upstream_task.await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while metrics.snapshot().completed_connections == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let snapshot = metrics.snapshot();
    assert_eq!(snapshot.accepted_connections, 1);
    assert_eq!(snapshot.completed_connections, 1);
    assert_eq!(snapshot.proxy_failures, 0);
    assert_eq!(snapshot.client_to_upstream_bytes, 5);
    assert_eq!(snapshot.upstream_to_client_bytes, 5);
    cancellation.cancel();
    proxy_task.await.unwrap().unwrap();
}
