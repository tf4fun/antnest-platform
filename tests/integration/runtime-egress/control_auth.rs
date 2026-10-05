//! Real sockets exercise the production admission/router/listener together.
//! The in-memory repository and no-op kernel belong to this Egress-only fixture.

#[path = "../../../services/runtime-egress/tests/support/pki.rs"]
mod pki;
#[path = "../../../services/runtime-egress/tests/support/mod.rs"]
mod support;

use std::{
    collections::HashMap, fs, io, net::SocketAddr, process::Stdio, sync::Arc, time::Duration,
};

use antnest_runtime_egress::{
    control::{health_router, router},
    telemetry::EgressMetrics,
    transport::{SecurityConfig, VerifiedPeer, healthcheck},
};
use pki::Pki;
use rcgen::{CertificateParams, ExtendedKeyUsagePurpose, KeyPair, SanType, date_time_ymd};
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{PrivatePkcs8KeyDer, ServerName},
};
use sha2::{Digest as _, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    process::Command,
    task::JoinHandle,
    time::timeout,
};
use tokio_rustls::TlsConnector;
use tokio_util::sync::CancellationToken;

const NORMAL_TIMEOUT: Duration = Duration::from_secs(3);
const ROUTES: [(&str, &str); 8] = [
    ("GET", "/internal/agent-networks/component"),
    ("PUT", "/internal/agent-networks/component"),
    ("PUT", "/internal/agent-network-attachments/component"),
    ("POST", "/internal/agent-networks/component/release"),
    ("PUT", "/internal/policies/component/revisions/1"),
    ("GET", "/internal/policies/component/revisions/1"),
    ("GET", "/internal/agent-policy-assignments/component"),
    ("PUT", "/internal/agent-policy-assignments/component"),
];

struct Server {
    endpoint: SocketAddr,
    cancellation: CancellationToken,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl Server {
    async fn control(security: &SecurityConfig) -> Self {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = tcp.local_addr().unwrap();
        let listener = security.listener(tcp);
        let app = router(
            support::service().await,
            EgressMetrics::default(),
            security.admission(),
        );
        let cancellation = CancellationToken::new();
        let stop = cancellation.clone();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<VerifiedPeer>(),
            )
            .with_graceful_shutdown(stop.cancelled_owned())
            .await
        });
        Self {
            endpoint,
            cancellation,
            task: Some(task),
        }
    }

    async fn health() -> Self {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = tcp.local_addr().unwrap();
        let service = support::service().await;
        // The contract preserves HTTP 200 for degraded status as well as ready.
        service.observe_repository_health(false);
        let app = health_router(service, EgressMetrics::default());
        let cancellation = CancellationToken::new();
        let stop = cancellation.clone();
        let task = tokio::spawn(async move {
            axum::serve(tcp, app)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await
        });
        Self {
            endpoint,
            cancellation,
            task: Some(task),
        }
    }

    async fn stop(mut self) {
        self.cancellation.cancel();
        let mut task = self.task.take().unwrap();
        let result = timeout(NORMAL_TIMEOUT, &mut task).await;
        if result.is_err() {
            task.abort();
            let _ = task.await;
        }
        assert!(
            matches!(result, Ok(Ok(Ok(())))),
            "owned HTTP server did not drain"
        );
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn token_values(root: &tempfile::TempDir, caller: &str) -> HashMap<String, String> {
    let digest = Sha256::digest(support::workload_token().as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let file = root.path().join("callers.json");
    fs::write(&file, format!("{{\"{caller}\":[\"sha256:{hex}\"]}}")).unwrap();
    HashMap::from([
        ("ANTNEST_SERVICE_AUTH_MODE".to_owned(), "token".to_owned()),
        (
            "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT".to_owned(),
            "true".to_owned(),
        ),
        (
            "ANTNEST_SERVICE_AUTH_CALLERS_FILE".to_owned(),
            file.to_string_lossy().into_owned(),
        ),
    ])
}

fn client_params(uris: &[&str]) -> CertificateParams {
    let mut params = CertificateParams::default();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.subject_alt_names = uris
        .iter()
        .map(|uri| SanType::URI((*uri).try_into().unwrap()))
        .collect();
    params
}

fn client(trust: &Pki, issuer: &Pki, params: Option<CertificateParams>) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.add(trust.ca.der().clone()).unwrap();
    let builder =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots);
    let config = if let Some(params) = params {
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &issuer.ca).unwrap();
        builder
            .with_client_auth_cert(
                vec![cert.der().clone()],
                PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
            )
            .unwrap()
    } else {
        builder.with_no_client_auth()
    };
    Arc::new(config)
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn error(&self, status: u16, code: &str) {
        assert_eq!(self.status, status);
        let challenge = self
            .headers
            .iter()
            .filter(|(name, _)| name == "www-authenticate")
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();
        if status == 401 {
            assert_eq!(challenge, ["Bearer realm=\"antnest-service\""]);
        } else {
            assert!(challenge.is_empty());
        }
        let value: serde_json::Value = serde_json::from_slice(&self.body).unwrap();
        assert_eq!(value["code"], code);
        assert_eq!(value["retryable"], false);
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(!String::from_utf8_lossy(&self.body).contains(support::workload_token()));
    }
}

fn wire(
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    declared: usize,
) -> Vec<u8> {
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: egress.test\r\nConnection: close\r\nContent-Length: {declared}\r\n"
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    let mut request = request.into_bytes();
    request.extend_from_slice(body);
    request
}

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    request: Vec<u8>,
) -> io::Result<HttpResponse> {
    stream.write_all(&request).await?;
    stream.flush().await?;
    let mut raw = Vec::new();
    stream.take(32769).read_to_end(&mut raw).await?;
    if raw.len() > 32768 {
        return Err(io::Error::other("oversized fixture response"));
    }
    let separator = raw
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("missing HTTP response"))?;
    let head = std::str::from_utf8(&raw[..separator])
        .map_err(|_| io::Error::other("invalid response headers"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::other("invalid response status"))?;
    let headers = head
        .lines()
        .skip(1)
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect::<Vec<_>>();
    let mut body = raw[separator + 4..].to_vec();
    if headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value == "chunked")
    {
        let mut remaining = body.as_slice();
        let mut decoded = Vec::new();
        loop {
            let end = remaining
                .windows(2)
                .position(|bytes| bytes == b"\r\n")
                .ok_or_else(|| io::Error::other("invalid chunk framing"))?;
            let size = std::str::from_utf8(&remaining[..end])
                .ok()
                .and_then(|text| usize::from_str_radix(text, 16).ok())
                .ok_or_else(|| io::Error::other("invalid chunk length"))?;
            remaining = &remaining[end + 2..];
            if size == 0 {
                break;
            }
            if remaining.len() < size + 2 {
                return Err(io::Error::other("truncated chunk"));
            }
            decoded.extend_from_slice(&remaining[..size]);
            remaining = &remaining[size + 2..];
        }
        body = decoded;
    }
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

async fn plain(
    server: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> HttpResponse {
    timeout(NORMAL_TIMEOUT, async {
        exchange(
            TcpStream::connect(server.endpoint).await?,
            wire(method, path, headers, body, body.len()),
        )
        .await
    })
    .await
    .unwrap()
    .unwrap()
}

async fn tls(
    server: &Server,
    config: Arc<ClientConfig>,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> io::Result<HttpResponse> {
    let tcp = TcpStream::connect(server.endpoint).await?;
    let stream = TlsConnector::from(config)
        .connect(ServerName::try_from("egress.test").unwrap(), tcp)
        .await?;
    exchange(stream, wire(method, path, headers, body, body.len())).await
}

#[tokio::test]
async fn real_token_http_preserves_field_multiplicity_and_no_effect_admission() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::control(
        &SecurityConfig::from_values(&token_values(&root, "agent-controller")).unwrap(),
    )
    .await;
    let authority = support::workload_header();
    for headers in [
        vec![],
        vec![
            ("authorization", authority.as_str()),
            ("x-antnest-service", "agent-controller"),
        ],
        vec![
            ("Antnest-Service-Authorization", authority.as_str()),
            ("aNtnest-service-authorization", authority.as_str()),
        ],
        vec![("Antnest-Service-Authorization", "Bearer unrecognized")],
    ] {
        plain(
            &server,
            "PUT",
            "/internal/agent-networks/denied",
            &headers,
            b"",
        )
        .await
        .error(401, "service_unauthenticated");
    }
    let accepted = plain(
        &server,
        "PUT",
        "/internal/agent-networks/accepted",
        &[("Antnest-Service-Authorization", &authority)],
        b"",
    )
    .await;
    assert_eq!(accepted.status, 200);
    let value: serde_json::Value = serde_json::from_slice(&accepted.body).unwrap();
    assert_eq!(value["tunnel_ipv4"], "100.64.0.2");
    assert_eq!(value["attachment_state"], "closed");
    let malformed = format!("Bearer  {}", support::workload_token());
    plain(
        &server,
        "GET",
        "/internal/agent-networks/accepted",
        &[("Antnest-Service-Authorization", &malformed)],
        b"",
    )
    .await
    .error(401, "service_unauthenticated");
    plain(
        &server,
        "GET",
        "/status",
        &[("Antnest-Service-Authorization", &authority)],
        b"",
    )
    .await
    .error(404, "route_not_found");
    server.stop().await;
}

#[tokio::test]
async fn real_json_wire_rejects_ambiguous_media_encoding_query_duplicates_and_size() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::control(
        &SecurityConfig::from_values(&token_values(&root, "agent-controller")).unwrap(),
    )
    .await;
    let authority = support::workload_header();
    let path = "/internal/policies/strict/revisions/1";
    for extras in [
        vec![("Content-Type", "text/plain")],
        vec![
            ("Content-Type", "application/json"),
            ("Content-Type", "application/json"),
        ],
        vec![
            ("Content-Type", "application/json"),
            ("Content-Encoding", "gzip"),
        ],
    ] {
        let mut headers = vec![("Antnest-Service-Authorization", authority.as_str())];
        headers.extend(extras);
        plain(&server, "PUT", path, &headers, b"{}")
            .await
            .error(415, "unsupported_media_type");
    }
    let headers = [
        ("Antnest-Service-Authorization", authority.as_str()),
        ("Content-Type", "application/json; charset=utf-8"),
    ];
    plain(
        &server,
        "PUT",
        path,
        &headers,
        br#"{"spec":{"schema_version":1,"action":"deny_all","\u0061ction":"allow_all"}}"#,
    )
    .await
    .error(400, "invalid_request");
    plain(
        &server,
        "PUT",
        &format!("{path}?ignored=1"),
        &headers,
        b"{}",
    )
    .await
    .error(400, "invalid_request");
    plain(&server, "PUT", path, &headers, &vec![b' '; 4097])
        .await
        .error(413, "invalid_request");
    plain(&server, "GET", path, &headers, b"")
        .await
        .error(404, "policy_revision_not_found");
    server.stop().await;
}

#[tokio::test]
async fn mtls_uses_verified_uri_and_never_headers_cn_or_a_valid_token_to_change_caller() {
    let pki = Pki::new();
    let values = pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    );
    let server = Server::control(&SecurityConfig::from_values(&values).unwrap()).await;
    let controller = client(
        &pki,
        &pki,
        Some(client_params(&["antnest://service/agent-controller"])),
    );
    let response = timeout(
        NORMAL_TIMEOUT,
        tls(
            &server,
            controller,
            "PUT",
            "/internal/agent-networks/accepted",
            &[],
            b"",
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status, 200);
    let authority = support::workload_header();
    for caller in [
        "runtime-controller",
        "agent-acp-service",
        "antnest-runtime",
        "skill-registry",
    ] {
        let config = client(
            &pki,
            &pki,
            Some(client_params(&[&format!("antnest://service/{caller}")])),
        );
        for (method, path) in ROUTES {
            timeout(
                NORMAL_TIMEOUT,
                tls(
                    &server,
                    config.clone(),
                    method,
                    path,
                    &[
                        ("Antnest-Service-Authorization", &authority),
                        ("x-antnest-service", "agent-controller"),
                    ],
                    b"invalid",
                ),
            )
            .await
            .unwrap()
            .unwrap()
            .error(403, "caller_not_allowed");
        }
    }
    for uris in [
        vec![],
        vec!["antnest://service/unknown"],
        vec![
            "antnest://service/agent-controller",
            "antnest://service/agent-controller",
        ],
        vec!["antnest://service/agent-controller/"],
        vec!["spiffe://service/agent-controller"],
    ] {
        let mut params = client_params(&uris);
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "agent-controller");
        let config = client(&pki, &pki, Some(params));
        timeout(
            NORMAL_TIMEOUT,
            tls(
                &server,
                config,
                "PUT",
                "/internal/agent-networks/forged",
                &[
                    ("Antnest-Service-Authorization", &authority),
                    ("x-antnest-service", "agent-controller"),
                ],
                b"",
            ),
        )
        .await
        .unwrap()
        .unwrap()
        .error(401, "service_unauthenticated");
    }
    server.stop().await;
}

#[tokio::test]
async fn mtls_rejects_missing_untrusted_expired_future_or_server_only_client_certificates() {
    let pki = Pki::new();
    let foreign = Pki::new();
    let values = pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    );
    let server = Server::control(&SecurityConfig::from_values(&values).unwrap()).await;
    let mut expired = client_params(&["antnest://service/agent-controller"]);
    expired.not_before = date_time_ymd(2000, 1, 1);
    expired.not_after = date_time_ymd(2001, 1, 1);
    let mut future = client_params(&["antnest://service/agent-controller"]);
    future.not_before = date_time_ymd(3000, 1, 1);
    future.not_after = date_time_ymd(3001, 1, 1);
    let mut server_only = client_params(&["antnest://service/agent-controller"]);
    server_only.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    for config in [
        client(&pki, &pki, None),
        client(
            &pki,
            &foreign,
            Some(client_params(&["antnest://service/agent-controller"])),
        ),
        client(&pki, &pki, Some(expired)),
        client(&pki, &pki, Some(future)),
        client(&pki, &pki, Some(server_only)),
    ] {
        assert!(
            timeout(
                NORMAL_TIMEOUT,
                tls(
                    &server,
                    config,
                    "PUT",
                    "/internal/agent-networks/forged",
                    &[],
                    b""
                )
            )
            .await
            .unwrap()
            .is_err()
        );
    }
    server.stop().await;
}

#[tokio::test]
async fn token_tls_cannot_be_downgraded_even_when_development_http_is_opted_in() {
    let pki = Pki::new();
    let mut values = token_values(&pki.root, "agent-controller");
    values.extend(pki.values(
        "token",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    ));
    let server = Server::control(&SecurityConfig::from_values(&values).unwrap()).await;
    let authority = support::workload_header();
    let config = client(&pki, &pki, None);
    let response = timeout(
        NORMAL_TIMEOUT,
        tls(
            &server,
            config,
            "PUT",
            "/internal/agent-networks/accepted",
            &[("Antnest-Service-Authorization", &authority)],
            b"",
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status, 200);
    let mut tcp = TcpStream::connect(server.endpoint).await.unwrap();
    tcp.write_all(&wire(
        "PUT",
        "/internal/agent-networks/plaintext",
        &[("Antnest-Service-Authorization", &authority)],
        b"",
        0,
    ))
    .await
    .unwrap();
    let mut raw = Vec::new();
    let _ = timeout(NORMAL_TIMEOUT, tcp.read_to_end(&mut raw))
        .await
        .unwrap();
    assert!(!raw.windows(5).any(|bytes| bytes == b"HTTP/"));
    server.stop().await;
}

#[tokio::test]
async fn one_slow_tls_handshake_does_not_serialize_clients_and_shutdown_cancels_it() {
    let pki = Pki::new();
    let security = SecurityConfig::from_values(&pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    ))
    .unwrap();
    let server = Server::control(&security).await;
    let mut slow = TcpStream::connect(server.endpoint).await.unwrap();
    let config = client(
        &pki,
        &pki,
        Some(client_params(&["antnest://service/agent-controller"])),
    );
    let response = timeout(
        NORMAL_TIMEOUT,
        tls(
            &server,
            config,
            "PUT",
            "/internal/agent-networks/concurrent",
            &[],
            b"",
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status, 200);
    let endpoint = server.endpoint;
    server.stop().await;
    let mut raw = Vec::new();
    assert_eq!(
        timeout(NORMAL_TIMEOUT, slow.read_to_end(&mut raw))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(TcpStream::connect(endpoint).await.is_err());
}

#[tokio::test]
async fn sixteen_pending_handshakes_bound_admission_and_expire_without_holding_health() {
    let pki = Pki::new();
    let security = SecurityConfig::from_values(&pki.values(
        "mtls",
        Pki::server_params(&["antnest://service/runtime-egress"]),
    ))
    .unwrap();
    let server = Server::control(&security).await;
    let mut slow = Vec::new();
    for _ in 0..16 {
        slow.push(TcpStream::connect(server.endpoint).await.unwrap());
    }
    let health = Server::health().await;
    assert_eq!(plain(&health, "GET", "/status", &[], b"").await.status, 200);
    let config = client(
        &pki,
        &pki,
        Some(client_params(&["antnest://service/agent-controller"])),
    );
    let mut next = Box::pin(tls(
        &server,
        config,
        "PUT",
        "/internal/agent-networks/after-timeout",
        &[],
        b"",
    ));
    assert!(
        timeout(Duration::from_secs(2), &mut next).await.is_err(),
        "a seventeenth handshake bypassed the bound"
    );
    assert_eq!(
        timeout(Duration::from_secs(8), &mut next)
            .await
            .unwrap()
            .unwrap()
            .status,
        200
    );
    drop(next);
    drop(slow);
    health.stop().await;
    server.stop().await;
}

#[tokio::test]
async fn body_read_timeout_is_bounded_and_authentication_never_waits_for_it() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::control(
        &SecurityConfig::from_values(&token_values(&root, "agent-controller")).unwrap(),
    )
    .await;
    let mut anonymous = TcpStream::connect(server.endpoint).await.unwrap();
    anonymous
        .write_all(&wire(
            "PUT",
            "/internal/policies/slow/revisions/1",
            &[("Content-Type", "application/json")],
            b"{",
            100,
        ))
        .await
        .unwrap();
    let response = timeout(NORMAL_TIMEOUT, exchange(anonymous, Vec::new()))
        .await
        .unwrap()
        .unwrap();
    response.error(401, "service_unauthenticated");
    let authority = support::workload_header();
    let request = wire(
        "PUT",
        "/internal/policies/slow/revisions/1",
        &[
            ("Antnest-Service-Authorization", &authority),
            ("Content-Type", "application/json"),
        ],
        b"{",
        100,
    );
    let stream = TcpStream::connect(server.endpoint).await.unwrap();
    let response = timeout(Duration::from_secs(10), exchange(stream, request))
        .await
        .unwrap()
        .unwrap();
    response.error(400, "invalid_request");
    plain(
        &server,
        "GET",
        "/internal/policies/slow/revisions/1",
        &[("Antnest-Service-Authorization", &authority)],
        b"",
    )
    .await
    .error(404, "policy_revision_not_found");
    server.stop().await;
}

#[tokio::test]
async fn health_cli_needs_no_workload_database_or_signing_configuration_and_is_loopback_only() {
    let server = Server::health().await;
    let endpoint = match server.endpoint {
        SocketAddr::V4(endpoint) => endpoint,
        _ => unreachable!(),
    };
    healthcheck(endpoint).await.unwrap();
    let status = plain(&server, "GET", "/status", &[], b"").await;
    let document: serde_json::Value = serde_json::from_slice(&status.body).unwrap();
    assert_eq!(document["status"], "degraded");
    assert_eq!(document.as_object().unwrap().len(), 4);
    plain(&server, "PUT", "/internal/agent-networks/never", &[], b"")
        .await
        .error(404, "route_not_found");
    let output = Command::new(env!("CARGO_BIN_EXE_antnest-runtime-egress"))
        .arg("--healthcheck")
        .env_clear()
        .env("ANTNEST_EGRESS_HEALTH_LISTEN", endpoint.to_string())
        .env("ANTNEST_SERVICE_AUTH_MODE", "invalid")
        .env(
            "ANTNEST_SERVICE_AUTH_CALLERS_FILE",
            "/missing-must-not-open",
        )
        .env("ANTNEST_EGRESS_DATABASE_URL", "invalid-must-not-connect")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "local healthcheck tried business bootstrap"
    );
    assert!(
        healthcheck("10.20.0.8:8082".parse().unwrap())
            .await
            .is_err()
    );
    server.stop().await;
    assert!(healthcheck(endpoint).await.is_err());
}
