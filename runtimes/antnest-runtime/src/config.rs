use std::env;
use std::net::{Ipv4Addr, SocketAddrV4};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::spec::{
    FilesystemSpec, NetworkMode, NetworkSpec, RuntimeIdentity, RuntimeSpec, UdpEndpoint,
};

#[derive(Debug, Error)]
pub(crate) enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} is invalid: {message}")]
    Invalid { name: &'static str, message: String },
    #[error("invalid egress endpoint: {0}")]
    Endpoint(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeSpecInput {
    pub(crate) agent_id: String,
    pub(crate) generation: u64,
    pub(crate) listen: String,
    pub(crate) network: NetworkSpecInput,
    pub(crate) filesystem: FilesystemSpecInput,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum NetworkSpecInput {
    Restricted {
        tunnel_ipv4: String,
        resolver_ipv4: String,
    },
    Unrestricted {
        egress_endpoint: String,
        tunnel_ipv4: String,
        resolver_ipv4: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FilesystemSpecInput {
    pub(crate) workspace: String,
    pub(crate) system_skills: String,
}

pub(crate) fn load() -> Result<RuntimeSpec, ConfigError> {
    RuntimeSpecInput::from_environment()?.try_into_runtime_spec()
}

pub(crate) fn load_telemetry() -> crate::telemetry::TelemetryConfig {
    crate::telemetry::TelemetryConfig::resolve(crate::telemetry::TelemetryEnvironment {
        log_filter: env::var("RUST_LOG").ok(),
        sdk_disabled: env::var("OTEL_SDK_DISABLED").ok(),
        exporter: env::var("OTEL_TRACES_EXPORTER").ok(),
        traces_endpoint: env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").ok(),
        endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
        traces_protocol: env::var("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").ok(),
        protocol: env::var("OTEL_EXPORTER_OTLP_PROTOCOL").ok(),
    })
}

impl RuntimeSpecInput {
    fn from_environment() -> Result<Self, ConfigError> {
        let network = match network_mode()? {
            NetworkMode::Restricted => NetworkSpecInput::Restricted {
                tunnel_ipv4: required("ANTNEST_RUNTIME_TUNNEL_IPV4")?,
                resolver_ipv4: required("ANTNEST_RUNTIME_DNS_IPV4")?,
            },
            NetworkMode::Unrestricted => NetworkSpecInput::Unrestricted {
                egress_endpoint: required("ANTNEST_RUNTIME_EGRESS_ENDPOINT")?,
                tunnel_ipv4: required("ANTNEST_RUNTIME_TUNNEL_IPV4")?,
                resolver_ipv4: required("ANTNEST_RUNTIME_DNS_IPV4")?,
            },
        };
        Ok(Self {
            agent_id: required("ANTNEST_AGENT_ID")?,
            generation: positive_u64("ANTNEST_RUNTIME_GENERATION")?,
            listen: env_or("ANTNEST_RUNTIME_LISTEN", "0.0.0.0:8093"),
            network,
            filesystem: FilesystemSpecInput {
                workspace: env_or("ANTNEST_RUNTIME_WORKSPACE", "/workspace"),
                system_skills: env_or("ANTNEST_RUNTIME_SYSTEM_SKILLS", "/skills"),
            },
        })
    }

    pub(crate) fn try_into_runtime_spec(self) -> Result<RuntimeSpec, ConfigError> {
        let network = match self.network {
            NetworkSpecInput::Restricted {
                tunnel_ipv4,
                resolver_ipv4,
            } => NetworkSpec::restricted(
                parse_ipv4("network.tunnel_ipv4", &tunnel_ipv4)?,
                parse_ipv4("network.resolver_ipv4", &resolver_ipv4)?,
            )
            .map_err(|error| invalid_spec("network", error))?,
            NetworkSpecInput::Unrestricted {
                egress_endpoint,
                tunnel_ipv4,
                resolver_ipv4,
            } => NetworkSpec::unrestricted(
                parse_endpoint(&egress_endpoint)?,
                parse_ipv4("network.tunnel_ipv4", &tunnel_ipv4)?,
                parse_ipv4("network.resolver_ipv4", &resolver_ipv4)?,
            )
            .map_err(|error| invalid_spec("network", error))?,
        };
        let identity = RuntimeIdentity::new(self.agent_id, self.generation)
            .map_err(|error| invalid_spec("identity", error))?;
        let listen = self
            .listen
            .parse()
            .map_err(|error: std::net::AddrParseError| ConfigError::Invalid {
                name: "ANTNEST_RUNTIME_LISTEN",
                message: error.to_string(),
            })?;
        let filesystem =
            FilesystemSpec::new(self.filesystem.workspace, self.filesystem.system_skills)
                .map_err(|error| invalid_spec("filesystem", error))?;
        RuntimeSpec::new(identity, listen, network, filesystem)
            .map_err(|error| invalid_spec("listen", error))
    }
}

fn invalid_spec(name: &'static str, error: crate::spec::SpecError) -> ConfigError {
    ConfigError::Invalid {
        name,
        message: error.to_string(),
    }
}

fn parse_ipv4(name: &'static str, value: &str) -> Result<Ipv4Addr, ConfigError> {
    let address = value
        .parse::<Ipv4Addr>()
        .map_err(|error| ConfigError::Invalid {
            name,
            message: error.to_string(),
        })?;
    Ok(address)
}

// Provider owns service discovery; the Runtime domain receives one concrete endpoint.
pub(crate) fn parse_endpoint(value: &str) -> Result<UdpEndpoint, ConfigError> {
    let address = value
        .trim()
        .parse::<SocketAddrV4>()
        .map_err(|error| ConfigError::Endpoint(error.to_string()))?;
    UdpEndpoint::new(address).map_err(|error| ConfigError::Endpoint(error.to_string()))
}

fn network_mode() -> Result<NetworkMode, ConfigError> {
    match required("ANTNEST_RUNTIME_NETWORK_MODE")?.as_str() {
        "restricted" => Ok(NetworkMode::Restricted),
        "unrestricted" => Ok(NetworkMode::Unrestricted),
        _ => Err(ConfigError::Invalid {
            name: "ANTNEST_RUNTIME_NETWORK_MODE",
            message: "must be restricted or unrestricted".into(),
        }),
    }
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::Missing(name))
}

fn positive_u64(name: &'static str) -> Result<u64, ConfigError> {
    let value = required(name)?;
    let parsed = value.parse::<u64>().map_err(|error| ConfigError::Invalid {
        name,
        message: error.to_string(),
    })?;
    if parsed == 0 {
        return Err(ConfigError::Invalid {
            name,
            message: "must be positive".into(),
        });
    }
    Ok(parsed)
}

fn env_or(name: &str, fallback: &str) -> String {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_literal_ipv4_authority() {
        let endpoint = parse_endpoint("192.0.2.10:9443").unwrap();
        assert_eq!(endpoint.address(), "192.0.2.10:9443".parse().unwrap());
    }

    #[test]
    fn rejects_wildcard_authority() {
        assert!(parse_endpoint("0.0.0.0:9443").is_err());
    }

    #[test]
    fn rejects_hostname_authority_at_the_runtime_boundary() {
        assert!(parse_endpoint("localhost:9443").is_err());
    }
}
