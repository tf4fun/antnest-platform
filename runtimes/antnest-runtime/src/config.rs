use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::spec::{
    FilesystemSpec, NetworkSpec, RuntimeIdentity, RuntimeSpec, SkillMaintenanceVerifier,
    UdpEndpoint,
};

const RUNTIME_SPEC_ENV: &str = "ANTNEST_RUNTIME_SPEC";

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
    pub(crate) listen: SocketAddressInput,
    pub(crate) network: NetworkSpecInput,
    pub(crate) filesystem: FilesystemSpecInput,
    #[serde(default)]
    pub(crate) mcp_servers: Vec<crate::managed_mcp::spec::ServerInput>,
    #[serde(default)]
    pub(crate) skill_maintenance_verifiers: SkillMaintenanceVerifiersInput,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillMaintenanceVerifiersInput {
    pub(crate) keys: Vec<SkillMaintenanceVerifierInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillMaintenanceVerifierInput {
    pub(crate) kid: String,
    pub(crate) algorithm: String,
    pub(crate) public_key_base64url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NetworkSpecInput {
    pub(crate) packet_contract_revision: u32,
    pub(crate) egress_endpoint: Ipv4EndpointInput,
    pub(crate) tunnel_ipv4: String,
    pub(crate) resolver_ipv4: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SocketAddressInput {
    pub(crate) host: String,
    pub(crate) port: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Ipv4EndpointInput {
    pub(crate) ipv4: String,
    pub(crate) port: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FilesystemSpecInput {
    pub(crate) workspace: String,
    pub(crate) system_skills: String,
}

pub(crate) fn load() -> Result<RuntimeSpec, ConfigError> {
    let encoded = env::var(RUNTIME_SPEC_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(RUNTIME_SPEC_ENV))?;
    decode_runtime_spec(&encoded)
}

fn decode_runtime_spec(encoded: &str) -> Result<RuntimeSpec, ConfigError> {
    let input = serde_json::from_str::<RuntimeSpecInput>(encoded).map_err(|error| {
        ConfigError::Invalid {
            name: RUNTIME_SPEC_ENV,
            message: error.to_string(),
        }
    })?;
    input.try_into_runtime_spec()
}

pub(crate) fn load_telemetry() -> crate::telemetry::TelemetryConfig {
    crate::telemetry::TelemetryConfig::resolve(crate::telemetry::TelemetryEnvironment {
        image_reference: env::var("ANTNEST_RUNTIME_IMAGE_REFERENCE").ok(),
        image_id: env::var("ANTNEST_RUNTIME_IMAGE_ID").ok(),
        capture_rpc_content: env::var("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT").ok(),
        log_filter: env::var("RUST_LOG").ok(),
        sdk_disabled: env::var("OTEL_SDK_DISABLED").ok(),
        exporter: env::var("OTEL_TRACES_EXPORTER").ok(),
        traces_endpoint: env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").ok(),
        endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
        traces_protocol: env::var("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").ok(),
        protocol: env::var("OTEL_EXPORTER_OTLP_PROTOCOL").ok(),
        metrics_exporter: env::var("OTEL_METRICS_EXPORTER").ok(),
        metrics_endpoint: env::var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT").ok(),
        metrics_protocol: env::var("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL").ok(),
    })
}

impl RuntimeSpecInput {
    pub(crate) fn try_into_runtime_spec(self) -> Result<RuntimeSpec, ConfigError> {
        let maintenance_verifiers =
            validate_maintenance_verifiers(&self.skill_maintenance_verifiers.keys)?;
        if self.network.packet_contract_revision != crate::packet::PACKET_CONTRACT_REVISION {
            return Err(ConfigError::Invalid {
                name: "network.packet_contract_revision",
                message: format!(
                    "expected revision {}",
                    crate::packet::PACKET_CONTRACT_REVISION
                ),
            });
        }
        let network = NetworkSpec::new(
            endpoint_from_input(&self.network.egress_endpoint)?,
            parse_ipv4("network.tunnel_ipv4", &self.network.tunnel_ipv4)?,
            parse_ipv4("network.resolver_ipv4", &self.network.resolver_ipv4)?,
        )
        .map_err(|error| invalid_spec("network", error))?;
        let identity = RuntimeIdentity::new(self.agent_id, self.generation)
            .map_err(|error| invalid_spec("identity", error))?;
        let listen = socket_from_input("listen", &self.listen)?;
        let filesystem =
            FilesystemSpec::new(self.filesystem.workspace, self.filesystem.system_skills)
                .map_err(|error| invalid_spec("filesystem", error))?;
        RuntimeSpec::new(identity, listen, network, filesystem)
            .map_err(|error| invalid_spec("listen", error))
            .and_then(|spec| {
                crate::managed_mcp::spec::validate_servers(self.mcp_servers)
                    .map(|servers| {
                        spec.with_mcp_servers(servers)
                            .with_maintenance_verifiers(maintenance_verifiers)
                    })
                    .map_err(|error| ConfigError::Invalid {
                        name: "mcp_servers",
                        message: error.to_string(),
                    })
            })
    }
}

fn validate_maintenance_verifiers(
    keys: &[SkillMaintenanceVerifierInput],
) -> Result<Vec<SkillMaintenanceVerifier>, ConfigError> {
    if keys.len() > 2 {
        return Err(ConfigError::Invalid {
            name: "skill_maintenance_verifiers",
            message: "at most two public keys are allowed".into(),
        });
    }
    let mut validated = Vec::with_capacity(keys.len());
    for key in keys {
        if key.kid.is_empty()
            || key.kid.len() > 128
            || !key.kid.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
            })
            || key.algorithm != "Ed25519"
            || validated
                .iter()
                .any(|existing: &SkillMaintenanceVerifier| existing.kid() == key.kid)
        {
            return Err(ConfigError::Invalid {
                name: "skill_maintenance_verifiers",
                message: "invalid or duplicate public key identity".into(),
            });
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(key.public_key_base64url.as_bytes())
            .map_err(|_| ConfigError::Invalid {
                name: "skill_maintenance_verifiers",
                message: "invalid public key encoding".into(),
            })?;
        if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != key.public_key_base64url {
            return Err(ConfigError::Invalid {
                name: "skill_maintenance_verifiers",
                message: "public key must be canonical Ed25519 bytes".into(),
            });
        }
        let public_key: [u8; 32] = bytes.try_into().expect("length checked");
        validated.push(SkillMaintenanceVerifier::new(key.kid.clone(), public_key));
    }
    validated.sort_by(|left, right| left.kid().cmp(right.kid()));
    Ok(validated)
}

fn socket_from_input(
    name: &'static str,
    input: &SocketAddressInput,
) -> Result<SocketAddr, ConfigError> {
    let address = input
        .host
        .parse::<IpAddr>()
        .map_err(|error| ConfigError::Invalid {
            name,
            message: error.to_string(),
        })?;
    if input.port == 0 {
        return Err(ConfigError::Invalid {
            name,
            message: "port must be non-zero".into(),
        });
    }
    Ok(SocketAddr::new(address, input.port))
}

fn endpoint_from_input(input: &Ipv4EndpointInput) -> Result<UdpEndpoint, ConfigError> {
    let address = parse_ipv4("network.egress_endpoint.ipv4", &input.ipv4)?;
    UdpEndpoint::new(SocketAddrV4::new(address, input.port))
        .map_err(|error| ConfigError::Endpoint(error.to_string()))
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

// Egress owns this address; Runtime receives the concrete endpoint through RuntimeSpec.
#[cfg(test)]
pub(crate) fn parse_endpoint(value: &str) -> Result<UdpEndpoint, ConfigError> {
    let address = value
        .trim()
        .parse::<SocketAddrV4>()
        .map_err(|error| ConfigError::Endpoint(error.to_string()))?;
    UdpEndpoint::new(address).map_err(|error| ConfigError::Endpoint(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_spec_is_one_strict_json_document() {
        let encoded = serde_json::to_string(&valid_input()).unwrap();
        let spec = decode_runtime_spec(&encoded).unwrap();

        assert_eq!(spec.identity().agent_id(), "agent-config-test");
        assert_eq!(spec.identity().generation(), 7);
        assert_eq!(spec.listen().to_string(), "0.0.0.0:8093");
    }

    #[test]
    fn runtime_spec_rejects_unknown_fields_and_invalid_json() {
        let mut value = serde_json::to_value(valid_input()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("legacy_network_mode".into(), serde_json::json!("allow"));

        assert!(decode_runtime_spec(&value.to_string()).is_err());
        assert!(decode_runtime_spec("not-json").is_err());
    }

    #[test]
    fn maintenance_verifiers_are_optional_bounded_public_keys() {
        let empty = decode_runtime_spec(&serde_json::to_string(&valid_input()).unwrap()).unwrap();
        assert!(empty.maintenance_verifiers().is_empty());

        let mut value = serde_json::to_value(valid_input()).unwrap();
        value["skill_maintenance_verifiers"] = serde_json::json!({"keys": [{
            "kid": "learning-1", "algorithm": "Ed25519",
            "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        }]});
        let enabled = decode_runtime_spec(&value.to_string()).unwrap();
        assert_eq!(enabled.maintenance_verifiers().len(), 1);
        assert_eq!(enabled.maintenance_verifiers()[0].kid(), "learning-1");
        assert_eq!(enabled.maintenance_verifiers()[0].public_key(), &[0; 32]);

        for invalid in [
            serde_json::json!({"keys": [{"kid": "learning-1", "algorithm": "none",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}),
            serde_json::json!({"keys": [{"kid": "learning-1", "algorithm": "Ed25519",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}]}),
            serde_json::json!({"keys": [{"kid": "learning-1", "algorithm": "Ed25519",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
                {"kid": "learning-1", "algorithm": "Ed25519",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}),
            serde_json::json!({"keys": [{"kid": "a", "algorithm": "Ed25519",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
                {"kid": "b", "algorithm": "Ed25519",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
                {"kid": "c", "algorithm": "Ed25519",
                "public_key_base64url": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}),
        ] {
            value["skill_maintenance_verifiers"] = invalid;
            assert!(decode_runtime_spec(&value.to_string()).is_err());
        }
    }

    #[test]
    fn runtime_spec_preserves_validated_managed_servers() {
        let mut value = serde_json::to_value(valid_input()).unwrap();
        value["mcp_servers"] = serde_json::json!([{
            "id": "notes", "command": "python", "args": ["/workspace/notes.py"],
            "env": {"NOTES_KEY": "secret-canary"}
        }]);
        let spec = decode_runtime_spec(&value.to_string()).unwrap();
        assert_eq!(spec.mcp_servers()[0].id(), "notes");
        assert_eq!(
            spec.mcp_servers()[0].input().env["NOTES_KEY"],
            "secret-canary"
        );
        assert!(!format!("{spec:?}").contains("secret-canary"));
        value["mcp_servers"][0]["env"]["HOME"] = serde_json::json!("/root");
        assert!(decode_runtime_spec(&value.to_string()).is_err());
    }

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

    fn valid_input() -> RuntimeSpecInput {
        RuntimeSpecInput {
            agent_id: "agent-config-test".into(),
            mcp_servers: Vec::new(),
            skill_maintenance_verifiers: SkillMaintenanceVerifiersInput::default(),
            generation: 7,
            listen: SocketAddressInput {
                host: "0.0.0.0".into(),
                port: 8093,
            },
            network: NetworkSpecInput {
                packet_contract_revision: crate::packet::PACKET_CONTRACT_REVISION,
                egress_endpoint: Ipv4EndpointInput {
                    ipv4: "192.0.2.10".into(),
                    port: 8092,
                },
                tunnel_ipv4: "100.96.0.2".into(),
                resolver_ipv4: "100.64.0.1".into(),
            },
            filesystem: FilesystemSpecInput {
                workspace: "/workspace".into(),
                system_skills: "/skills".into(),
            },
        }
    }
}
