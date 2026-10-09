use std::{fmt, net::Ipv4Addr, str::FromStr, time::SystemTime};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use thiserror::Error;

use crate::policy::PolicySpec;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkState {
    Active,
    Quarantined,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentState {
    Closed,
    Open,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentNetwork {
    pub agent_id: AgentId,
    pub pool_id: String,
    pub tunnel_ipv4: Ipv4Addr,
    pub state: NetworkState,
    pub resource_version: u64,
    pub quarantine_until: Option<SystemTime>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyRevision {
    pub policy_id: PolicyId,
    pub revision: u64,
    pub spec: PolicySpec,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyAssignment {
    pub agent_id: AgentId,
    pub policy_id: PolicyId,
    pub revision: u64,
    pub resource_version: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAttachment {
    pub tunnel_key_id: Option<antnest_runtime_tunnel::KeyId>,
    pub agent_id: AgentId,
    pub state: AttachmentState,
    pub resource_version: u64,
    pub runtime_endpoint: Option<Ipv4Addr>,
}

pub fn valid_runtime_endpoint(state: AttachmentState, endpoint: Option<Ipv4Addr>) -> bool {
    match state {
        AttachmentState::Closed => endpoint.is_none(),
        AttachmentState::Open => endpoint.is_some_and(|address| {
            !address.is_unspecified() && !address.is_multicast() && !address.is_broadcast()
        }),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveBinding {
    pub network: AgentNetwork,
    pub attachment: RuntimeAttachment,
    pub assignment: PolicyAssignment,
    pub revision: PolicyRevision,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AgentId(String);

impl AgentId {
    pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
        let value = value.into();
        validate_identifier(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for AgentId {
    type Err = IdentifierError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for AgentId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for AgentId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PolicyId(String);

impl PolicyId {
    pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
        let value = value.into();
        validate_identifier(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PolicyId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for PolicyId {
    type Err = IdentifierError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for PolicyId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PolicyId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum IdentifierError {
    #[error("identifier must not be empty")]
    Empty,
    #[error("identifier must not contain whitespace")]
    Whitespace,
    #[error("identifier is too long")]
    TooLong,
    #[error("identifier must contain only visible ASCII bytes")]
    NotVisibleAscii,
}

fn validate_identifier(value: &str) -> Result<(), IdentifierError> {
    if value.is_empty() {
        return Err(IdentifierError::Empty);
    }
    if value.len() > 255 {
        return Err(IdentifierError::TooLong);
    }
    if !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        return if value.chars().any(char::is_whitespace) {
            Err(IdentifierError::Whitespace)
        } else {
            Err(IdentifierError::NotVisibleAscii)
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_have_one_small_rule_set() {
        assert_eq!(AgentId::parse(""), Err(IdentifierError::Empty));
        assert_eq!(
            PolicyId::parse("has space"),
            Err(IdentifierError::Whitespace)
        );
        assert_eq!(AgentId::parse("agent-1").unwrap().as_str(), "agent-1");
        assert!(AgentId::parse("a".repeat(255)).is_ok());
        assert_eq!(
            AgentId::parse("a".repeat(256)),
            Err(IdentifierError::TooLong)
        );
        assert_eq!(
            PolicyId::parse("policy-一"),
            Err(IdentifierError::NotVisibleAscii)
        );
    }
}
