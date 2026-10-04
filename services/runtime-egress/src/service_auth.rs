//! Exact workload primitives shared by the Egress control boundary.
//! Startup transport validation and HTTP admission remain service-owned.

use std::{collections::BTreeMap, fmt};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Deserializer, de::MapAccess, de::Visitor};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;

pub const SERVICE_HEADER: &str = "antnest-service-authorization";
pub const MAX_JSON_BYTES: usize = 4096;
pub(crate) const SERVICES: [&str; 10] = [
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    Unauthenticated,
    Forbidden,
}

#[derive(Clone, Debug)]
pub enum Admission {
    Token(Receiver),
    Mtls,
}

impl Admission {
    pub(crate) fn authorize_request(
        &self,
        request: &axum::http::Request<axum::body::Body>,
    ) -> Result<(), AdmissionError> {
        match self {
            Self::Token(receiver) => {
                let fields = request
                    .headers()
                    .get_all(SERVICE_HEADER)
                    .iter()
                    .map(|value| value.to_str().map(|value| (SERVICE_HEADER, value)))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| AdmissionError::Unauthenticated)?;
                receiver
                    .authorize_fields(&fields, &["agent-controller"])
                    .map(|_| ())
            }
            Self::Mtls => {
                // Only our verified listener can construct this connection identity.
                // Headers, arbitrary extensions and token credentials cannot supply it.
                let caller = request
                    .extensions()
                    .get::<axum::extract::ConnectInfo<crate::transport::VerifiedPeer>>()
                    .and_then(|peer| peer.0.caller())
                    .ok_or(AdmissionError::Unauthenticated)?;
                if caller == "agent-controller" {
                    Ok(())
                } else {
                    Err(AdmissionError::Forbidden)
                }
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("invalid Egress workload authentication configuration")]
pub struct ConfigError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModeKind {
    Token,
    Mtls,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Mode {
    pub kind: ModeKind,
    pub allow_insecure_transport: bool,
}

impl Mode {
    // Selecting a mode does not prove a TLS profile is present or trusted;
    // startup must validate the complete transport before opening a listener.
    pub fn parse(mode: Option<&str>, insecure: Option<&str>) -> Result<Self, ConfigError> {
        let kind = match mode {
            Some("token") => ModeKind::Token,
            Some("mtls") => ModeKind::Mtls,
            _ => return Err(ConfigError),
        };
        let allow_insecure_transport = match insecure.unwrap_or("false") {
            "true" => true,
            "false" => false,
            _ => return Err(ConfigError),
        };
        if kind == ModeKind::Mtls && allow_insecure_transport {
            return Err(ConfigError);
        }
        Ok(Self {
            kind,
            allow_insecure_transport,
        })
    }

    /// Enforce the selected listener transport. TLS material must also pass
    /// startup certificate validation before this listener can be opened.
    pub fn validate_transport(self, transport_is_tls: bool) -> Result<Self, ConfigError> {
        if !transport_is_tls && (self.kind != ModeKind::Token || !self.allow_insecure_transport) {
            return Err(ConfigError);
        }
        Ok(self)
    }
}

#[derive(Clone)]
pub struct Receiver {
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
    pub fn parse(raw: &[u8], receiver: &str, self_allowed: bool) -> Result<Self, ConfigError> {
        if raw.is_empty()
            || raw.len() > 8192
            || std::str::from_utf8(raw).is_err()
            || !SERVICES.contains(&receiver)
        {
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
                let Some(hex) = value.strip_prefix("sha256:").filter(|hex| {
                    hex.len() == 64
                        && hex
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

    pub fn authorize_fields(
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
        // Inspect every digest without returning at the first matching secret.
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

pub fn valid_token(value: &str) -> bool {
    if !(43..=86).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return false;
    }
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(value) else {
        return false;
    };
    (32..=64).contains(&bytes.len()) && URL_SAFE_NO_PAD.encode(bytes) == value
}

pub fn valid_json_media(values: &[&str]) -> bool {
    let [value] = values else {
        return false;
    };
    let Ok(media) = value.parse::<mime::Mime>() else {
        return false;
    };
    if media.essence_str() != "application/json" {
        return false;
    }
    let mut parameters = media.params();
    if let Some((name, value)) = parameters.next()
        && (name != mime::CHARSET || !value.as_str().eq_ignore_ascii_case("utf-8"))
    {
        return false;
    }
    parameters.next().is_none()
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

pub fn valid_json_body(raw: &[u8]) -> bool {
    if raw.len() > MAX_JSON_BYTES
        || std::str::from_utf8(raw).is_err()
        || raw
            .iter()
            .find(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
            != Some(&b'{')
    {
        return false;
    }
    // Bound nesting before recursive Serde parsing. Escaped quoted delimiters
    // never count as containers; Serde still validates all syntax afterward.
    let (mut depth, mut quoted, mut escaped) = (0_usize, false, false);
    for byte in raw {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 32 {
                        return false;
                    }
                }
                b'}' | b']' => {
                    let Some(next) = depth.checked_sub(1) else {
                        return false;
                    };
                    depth = next;
                }
                _ => {}
            }
        }
    }
    depth == 0 && !quoted && serde_json::from_slice::<UniqueJson>(raw).is_ok()
}
