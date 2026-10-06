use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub(crate) const MAX_SERVERS: usize = 8;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServerInput {
    pub(crate) id: String,
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) env: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) secret_env: BTreeMap<String, SecretDescriptor>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SecretDescriptor {
    #[serde(deserialize_with = "true_only")]
    pub(crate) set: bool,
    pub(crate) fingerprint: String,
}

fn true_only<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    if bool::deserialize(deserializer)? {
        Ok(true)
    } else {
        Err(serde::de::Error::custom("secret descriptor must be set"))
    }
}

impl std::fmt::Debug for ServerInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServerInput")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ServerSpec(ServerInput, u32);

impl ServerSpec {
    pub(crate) fn input(&self) -> &ServerInput {
        &self.0
    }
    pub(crate) fn id(&self) -> &str {
        &self.0.id
    }
    pub(crate) fn uid(&self) -> u32 {
        self.1
    }
}

#[derive(Debug, Error)]
#[error("invalid managed MCP configuration: {0}")]
pub(crate) struct ConfigError(pub(crate) &'static str);

pub(crate) fn validate_servers(inputs: Vec<ServerInput>) -> Result<Vec<ServerSpec>, ConfigError> {
    if inputs.len() > MAX_SERVERS {
        return Err(ConfigError("too many servers"));
    }
    let mut ids = BTreeSet::new();
    for input in &inputs {
        validate(input)?;
        if !ids.insert(&input.id) {
            return Err(ConfigError("duplicate server ID"));
        }
    }
    if serde_json::to_vec(&inputs)
        .map_err(|_| ConfigError("invalid server configuration"))?
        .len()
        > 64 * 1024
    {
        return Err(ConfigError("encoded server configurations exceed 64 KiB"));
    }
    Ok(inputs
        .into_iter()
        .enumerate()
        .map(|(index, input)| ServerSpec(input, 2000 + index as u32))
        .collect())
}

fn validate(input: &ServerInput) -> Result<(), ConfigError> {
    if input.id.is_empty()
        || input.id.len() > 16
        || !input.id.as_bytes()[0].is_ascii_lowercase()
        || !input
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(ConfigError(
            "server ID must be a 1-16 byte lowercase identifier",
        ));
    }
    if input.command.trim().is_empty()
        || !bounded(&input.command, 4096)
        || input.args.len() > 64
        || input.args.iter().any(|v| !bounded(v, 8192))
    {
        return Err(ConfigError("invalid command or arguments"));
    }
    if input.env.len() + input.secret_env.len() > 64
        || input.env.iter().any(|(name, value)| {
            name.is_empty()
                || name.len() > 128
                || name.bytes().enumerate().any(|(i, b)| {
                    !(b.is_ascii_alphabetic() || b == b'_' || i > 0 && b.is_ascii_digit())
                })
                || matches!(name.as_str(), "HOME" | "PATH")
                || name.starts_with("ANTNEST_")
                || !bounded(value, 8192)
        })
    {
        return Err(ConfigError("invalid or reserved environment variable"));
    }
    for (name, secret) in &input.secret_env {
        let valid_name = !name.is_empty()
            && name.len() <= 128
            && name
                .bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || i > 0 && b.is_ascii_digit());
        let fingerprint = secret.fingerprint.strip_prefix("sha256:");
        if !valid_name
            || matches!(name.as_str(), "HOME" | "PATH")
            || name.starts_with("ANTNEST_")
            || input.env.contains_key(name)
            || !secret.set
            || !fingerprint.is_some_and(|v| {
                v.len() == 8
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(ConfigError("invalid secret descriptor"));
        }
    }
    let size = input.command.len()
        + input.args.iter().map(String::len).sum::<usize>()
        + input
            .env
            .iter()
            .map(|(k, v)| k.len() + v.len())
            .sum::<usize>();
    if size > 32 * 1024 {
        return Err(ConfigError("server configuration exceeds 32 KiB"));
    }
    Ok(())
}

fn bounded(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}
