//! Egress-owned transport. Workload identity is sealed to a verified TLS connection.

use std::{
    collections::HashMap,
    fmt,
    fs::OpenOptions,
    io::{self, Read},
    sync::Arc,
    time::Duration,
};

use axum::{
    extract::connect_info::Connected,
    serve::{IncomingStream, Listener},
};
use rustls::{
    RootCertStore, ServerConfig,
    client::{WebPkiServerVerifier, danger::ServerCertVerifier as _},
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime, pem::PemObject as _},
    server::WebPkiClientVerifier,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
    net::TcpListener,
    task::JoinSet,
    time::{sleep, timeout},
};
use tokio_rustls::TlsAcceptor;
use x509_parser::{
    extensions::GeneralName,
    prelude::{FromDer as _, X509Certificate},
};

use crate::service_auth::{Admission, ConfigError, Mode, ModeKind, Receiver, SERVICES};

const TLS_KEYS: [&str; 4] = [
    "ANTNEST_TLS_CA_FILE",
    "ANTNEST_TLS_CERT_FILE",
    "ANTNEST_TLS_KEY_FILE",
    "ANTNEST_TLS_SERVER_NAME",
];
const MAX_TLS_FILE_BYTES: usize = 1024 * 1024;
const MAX_PENDING_HANDSHAKES: usize = 16;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SecurityConfig {
    admission: Admission,
    tls: Option<Arc<ServerConfig>>,
    mode: ModeKind,
}

impl fmt::Debug for SecurityConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecurityConfig")
            .field("mode", &self.mode)
            .field("uses_tls", &self.uses_tls())
            .finish_non_exhaustive()
    }
}

impl SecurityConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_values(&std::env::vars().collect())
    }

    pub fn from_values(values: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let mode = Mode::parse(
            values.get("ANTNEST_SERVICE_AUTH_MODE").map(String::as_str),
            values
                .get("ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT")
                .map(String::as_str),
        )?;
        let tls_selected = TLS_KEYS.iter().any(|key| values.contains_key(*key));
        mode.validate_transport(tls_selected)?;
        let tls = if tls_selected {
            Some(load_tls(values, mode.kind)?)
        } else {
            None
        };
        let admission = match mode.kind {
            ModeKind::Token => {
                let path = required(values, "ANTNEST_SERVICE_AUTH_CALLERS_FILE")?;
                Admission::Token(Receiver::parse(
                    &read_regular(path, 8192)?,
                    "runtime-egress",
                    false,
                )?)
            }
            ModeKind::Mtls => Admission::Mtls,
        };
        Ok(Self {
            admission,
            tls,
            mode: mode.kind,
        })
    }

    pub fn uses_tls(&self) -> bool {
        self.tls.is_some()
    }

    pub fn admission(&self) -> Admission {
        self.admission.clone()
    }

    pub fn listener(&self, listener: TcpListener) -> SecureListener {
        SecureListener {
            listener,
            acceptor: self.tls.clone().map(TlsAcceptor::from),
            mtls: self.mode == ModeKind::Mtls,
            handshakes: JoinSet::new(),
        }
    }
}

fn required<'a>(values: &'a HashMap<String, String>, key: &str) -> Result<&'a str, ConfigError> {
    values
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError)
}

fn read_regular(path: &str, limit: usize) -> Result<Vec<u8>, ConfigError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // Inspect the opened descriptor, including projected-secret symlink targets.
        // O_NONBLOCK prevents a FIFO from stalling configuration before inspection.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| ConfigError)?;
    if !file.metadata().map_err(|_| ConfigError)?.is_file() {
        return Err(ConfigError);
    }
    let mut raw = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| ConfigError)?;
    if raw.is_empty() || raw.len() > limit {
        return Err(ConfigError);
    }
    Ok(raw)
}

fn certificates(raw: &[u8]) -> Result<Vec<CertificateDer<'static>>, ConfigError> {
    let certs = CertificateDer::pem_slice_iter(raw)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ConfigError)?;
    if certs.is_empty() {
        return Err(ConfigError);
    }
    Ok(certs)
}

fn load_tls(
    values: &HashMap<String, String>,
    mode: ModeKind,
) -> Result<Arc<ServerConfig>, ConfigError> {
    let ca = certificates(&read_regular(
        required(values, TLS_KEYS[0])?,
        MAX_TLS_FILE_BYTES,
    )?)?;
    let certs = certificates(&read_regular(
        required(values, TLS_KEYS[1])?,
        MAX_TLS_FILE_BYTES,
    )?)?;
    let key_raw = read_regular(required(values, TLS_KEYS[2])?, MAX_TLS_FILE_BYTES)?;
    let mut keys = PrivateKeyDer::pem_slice_iter(&key_raw)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ConfigError)?;
    if keys.len() != 1 {
        return Err(ConfigError);
    }
    let key = keys.remove(0);
    let name = ServerName::try_from(required(values, TLS_KEYS[3])?).map_err(|_| ConfigError)?;
    if !matches!(name, ServerName::DnsName(_)) || workload_name(&certs[0]) != Some("runtime-egress")
    {
        return Err(ConfigError);
    }
    let mut roots = RootCertStore::empty();
    for cert in ca {
        roots.add(cert).map_err(|_| ConfigError)?;
    }
    let roots = Arc::new(roots);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    WebPkiServerVerifier::builder_with_provider(roots.clone(), provider.clone())
        .build()
        .map_err(|_| ConfigError)?
        .verify_server_cert(&certs[0], &certs[1..], &name, &[], UnixTime::now())
        .map_err(|_| ConfigError)?;
    let builder = ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| ConfigError)?;
    let builder = if mode == ModeKind::Mtls {
        builder.with_client_cert_verifier(
            WebPkiClientVerifier::builder_with_provider(roots, provider)
                .build()
                .map_err(|_| ConfigError)?,
        )
    } else {
        builder.with_no_client_auth()
    };
    let mut tls = builder
        .with_single_cert(certs, key)
        .map_err(|_| ConfigError)?;
    // This crate's HTTP adapter supports HTTP/1.1; never advertise unsupported h2.
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(tls))
}

fn workload_name(cert: &CertificateDer<'_>) -> Option<&'static str> {
    let (remaining, cert) = X509Certificate::from_der(cert.as_ref()).ok()?;
    if !remaining.is_empty() {
        return None;
    }
    let san = cert.subject_alternative_name().ok()??;
    let uris = san
        .value
        .general_names
        .iter()
        .filter_map(|name| match name {
            GeneralName::URI(value) => Some(*value),
            _ => None,
        })
        .collect::<Vec<_>>();
    let [uri] = uris.as_slice() else {
        return None;
    };
    let name = uri.strip_prefix("antnest://service/")?;
    SERVICES.iter().copied().find(|known| *known == name)
}

/// No public constructor: identity is supplied only by SecureListener after TLS verification.
#[derive(Clone)]
pub struct VerifiedPeer {
    caller: Option<&'static str>,
}

impl fmt::Debug for VerifiedPeer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("verified-workload-peer")
    }
}

impl VerifiedPeer {
    pub(crate) fn caller(&self) -> Option<&'static str> {
        self.caller
    }
}

impl Connected<IncomingStream<'_, SecureListener>> for VerifiedPeer {
    fn connect_info(stream: IncomingStream<'_, SecureListener>) -> Self {
        stream.remote_addr().clone()
    }
}

pub trait ConnectionIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ConnectionIo for T {}
type Accepted = (Box<dyn ConnectionIo>, VerifiedPeer);

pub struct SecureListener {
    listener: TcpListener,
    acceptor: Option<TlsAcceptor>,
    mtls: bool,
    // JoinSet owns these tasks and aborts them when the HTTP listener is dropped.
    handshakes: JoinSet<Option<Accepted>>,
}

/// A loopback-only local probe. It reads no workload or database configuration.
pub async fn healthcheck(endpoint: std::net::SocketAddrV4) -> io::Result<()> {
    let failed = || io::Error::other("Egress healthcheck failed");
    if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
        return Err(failed());
    }
    let result = timeout(Duration::from_secs(2), async {
        let mut stream = tokio::net::TcpStream::connect(endpoint).await?;
        stream
            .write_all(
                format!("GET /status HTTP/1.1\r\nHost: {endpoint}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await?;
        let mut response = Vec::new();
        stream.take(4097).read_to_end(&mut response).await?;
        if response.len() > 4096 {
            return Err(failed());
        }
        if health_response_ready(&response) {
            Ok(())
        } else {
            Err(failed())
        }
    })
    .await;
    match result {
        Ok(Ok(())) => Ok(()),
        _ => Err(failed()),
    }
}

fn health_response_ready(response: &[u8]) -> bool {
    let first_line = response
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    if !first_line.starts_with(b"HTTP/1.1 200 ") && !first_line.starts_with(b"HTTP/1.0 200 ") {
        return false;
    }
    let Some(headers_end) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&response[headers_end + 4..])
        .is_ok_and(|document| document["status"] == "ready")
}

impl Listener for SecureListener {
    type Io = Box<dyn ConnectionIo>;
    type Addr = VerifiedPeer;

    async fn accept(&mut self) -> Accepted {
        loop {
            tokio::select! {
                Some(result) = self.handshakes.join_next(), if !self.handshakes.is_empty() => {
                    if let Ok(Some(connection)) = result { return connection; }
                }
                result = self.listener.accept(), if self.handshakes.len() < MAX_PENDING_HANDSHAKES => {
                    let (stream, _) = match result {
                        Ok(pair) => pair,
                        Err(_) => {
                            tracing::warn!("control listener accept failed");
                            sleep(Duration::from_secs(1)).await;
                            continue;
                        }
                    };
                    let Some(acceptor) = self.acceptor.clone() else {
                        return (Box::new(stream), VerifiedPeer { caller: None });
                    };
                    let mtls = self.mtls;
                    self.handshakes.spawn(async move {
                        let tls = timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await.ok()?.ok()?;
                        let caller = if mtls {
                            tls.get_ref().1.peer_certificates().and_then(|chain| chain.first()).and_then(workload_name)
                        } else { None };
                        Some((Box::new(tls) as Box<dyn ConnectionIo>, VerifiedPeer { caller }))
                    });
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<VerifiedPeer> {
        self.listener
            .local_addr()
            .map(|_| VerifiedPeer { caller: None })
    }
}

#[cfg(test)]
mod health_tests {
    use super::health_response_ready;

    #[test]
    fn healthcheck_requires_ready_status_document() {
        for (code, body, ready) in [
            ("200 OK", r#"{"status":"ready"}"#, true),
            (
                "200 OK",
                r#"{ "status": "ready", "control_plane_ready": true }"#,
                true,
            ),
            ("200 OK", r#"{"status":"degraded"}"#, false),
            ("200 OK", r#"{"status":"starting"}"#, false),
            ("200 OK", r#"{"control_plane_ready":true}"#, false),
            ("200 OK", r#"{"status":true}"#, false),
            ("200 OK", "not-json", false),
            ("200 OK", "", false),
            ("503 Unavailable", r#"{"status":"ready"}"#, false),
        ] {
            let response = format!(
                "HTTP/1.1 {code}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            assert_eq!(
                health_response_ready(response.as_bytes()),
                ready,
                "{code} {body}"
            );
        }
        assert!(!health_response_ready(b"HTTP/1.1 200 OK\r\n"));
    }
}
