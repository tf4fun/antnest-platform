use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Read as _;
use std::os::fd::{AsRawFd as _, FromRawFd as _};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;

pub(crate) const SERVICE_HEADER: &str = "antnest-service-authorization";
pub(crate) const CALLERS_DIRECTORY: &str = "/run/antnest-auth";
pub(crate) const CALLERS_FILE: &str = "/run/antnest-auth/callers.json";
const SERVICES: [&str; 10] = [
    "identity-service",
    "edge-gateway",
    "admin-console",
    "agent-ui",
    "agent-controller",
    "agent-acp-service",
    "runtime-controller",
    "skill-registry",
    "runtime-egress",
    "antnest-runtime",
];

#[derive(Clone)]
pub(crate) struct Receiver {
    hashes: Vec<(String, [u8; 32])>,
}

impl fmt::Debug for Receiver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Receiver")
            .field("credential_count", &self.hashes.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AdmissionError {
    Unauthenticated,
    Forbidden,
}

#[derive(Debug, thiserror::Error)]
#[error("invalid Runtime workload authentication configuration")]
pub(crate) struct ConfigError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BootstrapDescriptor {
    pub(crate) tunnel: crate::tunnel_auth::Descriptor,
    pub(crate) connection_id: String,
    pub(crate) callers_file: String,
    pub(crate) receiver_digest: String,
}

impl BootstrapDescriptor {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        self.tunnel.validate()?;
        let connection = self
            .connection_id
            .strip_prefix("rci_")
            .filter(|v| v.len() == 32);
        if self.callers_file != CALLERS_FILE
            || !connection.is_some_and(|v| {
                v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || !valid_digest(&self.receiver_digest)
        {
            return Err(ConfigError);
        }
        Ok(())
    }
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub(crate) fn load_instance(descriptor: &BootstrapDescriptor) -> Result<Receiver, ConfigError> {
    let env = |name| {
        std::env::var(name).map(Some).or_else(|error| match error {
            std::env::VarError::NotPresent => Ok(None),
            _ => Err(ConfigError),
        })
    };
    validate_http_mode(
        env("ANTNEST_SERVICE_AUTH_MODE")?.as_deref(),
        env("ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT")?.as_deref(),
    )?;
    for name in [
        "ANTNEST_TLS_CA_FILE",
        "ANTNEST_TLS_CERT_FILE",
        "ANTNEST_TLS_KEY_FILE",
        "ANTNEST_TLS_SERVER_NAME",
    ] {
        if std::env::var_os(name).is_some() {
            return Err(ConfigError);
        }
    }
    if env("ANTNEST_SERVICE_AUTH_CALLERS_FILE")?.as_deref() != Some(CALLERS_FILE) {
        return Err(ConfigError);
    }
    read_receiver_directory(Path::new(CALLERS_DIRECTORY), descriptor, 0, 0)
}

// Production always supplies UID/GID 0; tests use their unprivileged owner to
// exercise the same opened-file checks without requiring host root access.
pub(crate) fn read_receiver_directory(
    directory: &Path,
    descriptor: &BootstrapDescriptor,
    uid: u32,
    gid: u32,
) -> Result<Receiver, ConfigError> {
    descriptor.validate()?;
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(directory)
        .map_err(|_| ConfigError)?;
    let stat = root.metadata().map_err(|_| ConfigError)?;
    if !stat.is_dir() || stat.uid() != uid || stat.gid() != gid || stat.mode() & 0o7777 != 0o700 {
        return Err(ConfigError);
    }
    let entries = fs::read_dir(directory)
        .map_err(|_| ConfigError)?
        .take(3)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ConfigError)?;
    if entries.len() != 2
        || !entries
            .iter()
            .any(|entry| entry.file_name() == "callers.json")
        || !entries
            .iter()
            .any(|entry| entry.file_name() == "tunnel.json")
    {
        return Err(ConfigError);
    }
    // Verify the complete private bootstrap before any Executor/MCP admission.
    crate::tunnel_auth::read_opened(&root, &descriptor.tunnel, uid, gid)?;
    // O_NONBLOCK ensures a malicious FIFO cannot stall startup; O_NOFOLLOW and
    // openat retain the already verified directory instead of following a link.
    let fd = unsafe {
        libc::openat(
            root.as_raw_fd(),
            c"callers.json".as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(ConfigError);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let stat = file.metadata().map_err(|_| ConfigError)?;
    if !stat.is_file()
        || stat.uid() != uid
        || stat.gid() != gid
        || stat.mode() & 0o7777 != 0o600
        || !(1..=8192).contains(&stat.len())
    {
        return Err(ConfigError);
    }
    let mut raw = Vec::new();
    file.take(8193)
        .read_to_end(&mut raw)
        .map_err(|_| ConfigError)?;
    let label = "sha256:".to_owned()
        + &Sha256::digest(&raw)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
    if raw.len() > 8192 || label != descriptor.receiver_digest {
        return Err(ConfigError);
    }
    let receiver = Receiver::parse(&raw, "antnest-runtime", false)?;
    if !["runtime-controller", "agent-acp-service"]
        .iter()
        .all(|caller| receiver.hashes.iter().any(|(name, _)| name == caller))
        || receiver
            .hashes
            .iter()
            .any(|(name, _)| !["runtime-controller", "agent-acp-service"].contains(&name.as_str()))
    {
        return Err(ConfigError);
    }
    Ok(receiver)
}

pub(crate) fn valid_json_media(values: &[&str]) -> bool {
    let [value] = values else {
        return false;
    };
    let mut parts = value.split(';');
    if !parts
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return false;
    }
    if let Some(parameter) = parts.next() {
        let Some((name, value)) = parameter.trim().split_once('=') else {
            return false;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(value);
        if !name.trim().eq_ignore_ascii_case("charset") || !value.eq_ignore_ascii_case("utf-8") {
            return false;
        }
    }
    parts.next().is_none()
}

struct UniqueJson;
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = UniqueJson;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("unique JSON")
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                while sequence.next_element::<UniqueJson>()?.is_some() {}
                Ok(UniqueJson)
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut names = std::collections::HashSet::new();
                while let Some(name) = map.next_key::<String>()? {
                    if !names.insert(name) {
                        return Err(serde::de::Error::custom("duplicate member"));
                    }
                    map.next_value::<UniqueJson>()?;
                }
                Ok(UniqueJson)
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

pub(crate) fn valid_json_body(raw: &[u8]) -> bool {
    raw.len() <= crate::executor_protocol::MAX_EXECUTOR_MESSAGE_BYTES
        && std::str::from_utf8(raw).is_ok()
        && serde_json::from_slice::<UniqueJson>(raw).is_ok()
}

#[derive(Clone)]
pub(crate) struct AdmissionState {
    receiver: Arc<Receiver>,
    hosts: Vec<String>,
}

impl AdmissionState {
    pub(crate) fn new(receiver: Receiver, management_alias: String, port: u16) -> Self {
        Self {
            receiver: Arc::new(receiver),
            hosts: [management_alias.as_str(), "localhost", "127.0.0.1", "[::1]"]
                .into_iter()
                .map(|host| format!("{host}:{port}"))
                .collect(),
        }
    }
    pub(crate) fn hosts(&self) -> &[String] {
        &self.hosts
    }
}

fn rejection(status: axum::http::StatusCode, code: &'static str) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    let mut response = (status, axum::Json(serde_json::json!({"code":code, "message":"Runtime request rejected", "retryable":false}))).into_response();
    if status == axum::http::StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            axum::http::header::WWW_AUTHENTICATE,
            axum::http::HeaderValue::from_static("Bearer realm=\"antnest-service\""),
        );
    }
    response
}

pub(crate) async fn admit_http(
    axum::extract::State(state): axum::extract::State<AdmissionState>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{Method, StatusCode, header};
    let path = request.uri().path();
    let live = path == "/status/live" && matches!(*request.method(), Method::GET | Method::HEAD);
    let mcp = path == "/mcp" || path.starts_with("/mcp/");
    let private_skill = path.starts_with("/internal/skill-maintenance/")
        || path.starts_with("/internal/skill-temporary/");
    let skill_upload = matches!(
        path,
        "/internal/skill-maintenance/install" | "/internal/skill-temporary/install"
    );
    if !live {
        let allowed: &[&str] = if path == "/status" {
            &["runtime-controller", "agent-acp-service"]
        } else if mcp || private_skill {
            &["agent-acp-service"]
        } else {
            &[]
        };
        let mut headers = request.headers().get_all(SERVICE_HEADER).iter();
        let value = match (headers.next(), headers.next()) {
            (Some(value), None) => value.to_str().ok(),
            _ => None,
        };
        let outcome = value
            .ok_or(AdmissionError::Unauthenticated)
            .and_then(|value| {
                state
                    .receiver
                    .authorize_fields(&[(SERVICE_HEADER, value)], allowed)
            });
        if let Err(error) = outcome {
            return match error {
                AdmissionError::Unauthenticated => {
                    rejection(StatusCode::UNAUTHORIZED, "runtime_unauthorized")
                }
                AdmissionError::Forbidden => rejection(StatusCode::FORBIDDEN, "caller_not_allowed"),
            };
        }
    }
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let host = match (hosts.next(), hosts.next()) {
        (Some(value), None) => value.to_str().ok(),
        (None, None) => request.uri().authority().map(|value| value.as_str()),
        _ => None,
    };
    if !host.is_some_and(|host| {
        state
            .hosts
            .iter()
            .any(|expected| host.eq_ignore_ascii_case(expected))
    }) {
        return rejection(StatusCode::FORBIDDEN, "host_not_allowed");
    }
    // Do not hand the bearer or unsigned delegated authority to SDK handlers.
    request.headers_mut().remove(SERVICE_HEADER);
    for name in [
        "antnest-caller-context",
        "x-antnest-principal-id",
        "x-antnest-subject-id",
        "x-antnest-organization-id",
        "x-antnest-role",
    ] {
        request.headers_mut().remove(name);
    }
    if mcp {
        request.headers_mut().remove(header::AUTHORIZATION);
    }
    // Skill Authorization remains the independently verified signed ticket.
    if request.method() == Method::POST && (mcp || private_skill) {
        let values = request
            .headers()
            .get_all(header::CONTENT_TYPE)
            .iter()
            .map(|value| value.to_str())
            .collect::<Result<Vec<_>, _>>();
        if skill_upload {
            // The existing signed upload parser retains its archive/body limits.
            // Workload authentication must not turn these multipart routes
            // into JSON RPCs or consume/alter the ticket-bound artifact bytes.
            if !values.is_ok_and(|values| {
                matches!(values.as_slice(), [value] if multer::parse_boundary(value).is_ok())
            }) {
                return rejection(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type");
            }
            return next.run(request).await;
        }
        if !values.is_ok_and(|values| valid_json_media(&values)) {
            return rejection(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type");
        }
        let (parts, body) = request.into_parts();
        let bytes =
            match axum::body::to_bytes(body, crate::executor_protocol::MAX_EXECUTOR_MESSAGE_BYTES)
                .await
            {
                Ok(bytes) => bytes,
                Err(_) => return rejection(StatusCode::PAYLOAD_TOO_LARGE, "invalid_request"),
            };
        if !valid_json_body(&bytes) {
            return rejection(StatusCode::BAD_REQUEST, "invalid_request");
        }
        request = axum::extract::Request::from_parts(parts, axum::body::Body::from(bytes));
        request.headers_mut().insert(
            header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("application/json"),
        );
    }
    next.run(request).await
}

#[cfg(test)]
pub(crate) fn test_token() -> &'static str {
    use ring::rand::{SecureRandom as _, SystemRandom};
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| {
        let mut raw = [0_u8; 32];
        SystemRandom::new().fill(&mut raw).unwrap();
        URL_SAFE_NO_PAD.encode(raw)
    })
}

#[cfg(test)]
pub(crate) fn test_receiver() -> Receiver {
    let digest = "sha256:".to_owned()
        + &Sha256::digest(test_token().as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
    Receiver::parse(
        serde_json::json!({"agent-acp-service":[digest]})
            .to_string()
            .as_bytes(),
        "antnest-runtime",
        false,
    )
    .unwrap()
}

#[cfg(test)]
pub(crate) fn test_header() -> String {
    format!("Bearer {}", test_token())
}

pub(crate) fn valid_token(value: &str) -> bool {
    if !(43..=86).contains(&value.len())
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return false;
    }
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(value) else {
        return false;
    };
    (32..=64).contains(&bytes.len()) && URL_SAFE_NO_PAD.encode(bytes) == value
}

pub(crate) fn validate_http_mode(
    mode: Option<&str>,
    insecure: Option<&str>,
) -> Result<(), ConfigError> {
    // Native Runtime has no TLS listener. Never invent an opt-in or downgrade.
    if mode != Some("token") || insecure != Some("true") {
        return Err(ConfigError);
    }
    Ok(())
}

struct HashProfile(BTreeMap<String, Vec<String>>);
impl<'de> Deserialize<'de> for HashProfile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ProfileVisitor;
        impl<'de> Visitor<'de> for ProfileVisitor {
            type Value = HashProfile;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a unique workload hash map")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut callers = BTreeMap::new();
                while let Some((caller, hashes)) = map.next_entry::<String, Vec<String>>()? {
                    if callers.insert(caller, hashes).is_some() {
                        return Err(serde::de::Error::custom("duplicate caller"));
                    }
                }
                Ok(HashProfile(callers))
            }
        }
        deserializer.deserialize_map(ProfileVisitor)
    }
}

impl Receiver {
    pub(crate) fn parse(
        raw: &[u8],
        receiver: &str,
        self_allowed: bool,
    ) -> Result<Self, ConfigError> {
        if raw.is_empty() || raw.len() > 8192 || std::str::from_utf8(raw).is_err() {
            return Err(ConfigError);
        }
        let profile: HashProfile = serde_json::from_slice(raw).map_err(|_| ConfigError)?;
        let mut hashes = Vec::<(String, [u8; 32])>::new();
        for (caller, values) in profile.0 {
            if !SERVICES.contains(&caller.as_str())
                || (!self_allowed && caller == receiver)
                || !(1..=2).contains(&values.len())
            {
                return Err(ConfigError);
            }
            for value in values {
                let Some(hex) = value.strip_prefix("sha256:").filter(|s| {
                    s.len() == 64
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }) else {
                    return Err(ConfigError);
                };
                let mut digest = [0_u8; 32];
                for (index, byte) in digest.iter_mut().enumerate() {
                    *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                        .map_err(|_| ConfigError)?;
                }
                if hashes.iter().any(|(_, existing)| *existing == digest) {
                    return Err(ConfigError);
                }
                hashes.push((caller.clone(), digest));
            }
        }
        Ok(Self { hashes })
    }

    pub(crate) fn authorize_fields(
        &self,
        fields: &[(&str, &str)],
        allowed: &[&str],
    ) -> Result<String, AdmissionError> {
        let mut values = fields
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(SERVICE_HEADER));
        let Some((_, value)) = values.next() else {
            return Err(AdmissionError::Unauthenticated);
        };
        if values.next().is_some() {
            return Err(AdmissionError::Unauthenticated);
        }
        let Some((scheme, token)) = value.split_once(' ') else {
            return Err(AdmissionError::Unauthenticated);
        };
        if !scheme.eq_ignore_ascii_case("Bearer") || !valid_token(token) {
            return Err(AdmissionError::Unauthenticated);
        }
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let mut caller = None;
        // Compare every configured digest; never return at the first match.
        for (service, expected) in &self.hashes {
            if bool::from(digest.ct_eq(expected)) {
                caller = Some(service.as_str());
            }
        }
        let caller = caller.ok_or(AdmissionError::Unauthenticated)?;
        if !allowed.contains(&caller) {
            return Err(AdmissionError::Forbidden);
        }
        Ok(caller.to_owned())
    }
}
