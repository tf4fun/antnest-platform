use std::{
    collections::HashMap,
    env,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};

use ipnet::Ipv4Net;
use thiserror::Error;

use crate::allocator::AddressPool;

pub use crate::repository::DatabaseTlsMode;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub database_url: String,
    pub development_secret_warnings: Vec<&'static str>,
    pub database_tls_mode: DatabaseTlsMode,
    pub database_startup_timeout: Duration,
    pub database_retry_delay: Duration,
    pub control_listen: SocketAddrV4,
    pub health_listen: SocketAddrV4,
    pub udp_advertise: SocketAddrV4,
    pub tunnel_cidr: Ipv4Net,
    pub resolver_ipv4: Ipv4Addr,
    pub quarantine: Duration,
    pub max_flows: usize,
    pub max_agent_flows: usize,
    pub flow_idle: Duration,
    pub dns_upstream: SocketAddr,
    pub tun_name: String,
    pub command_timeout: Duration,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ConfigError {
    #[error("missing environment variable {0}")]
    Missing(&'static str),
    #[error("invalid environment variable {0}")]
    Invalid(&'static str),
    #[error("{0} uses a published development value")]
    PublishedDevelopmentValue(&'static str),
    #[error("advertised UDP endpoint must not use an unspecified address")]
    UnspecifiedAdvertisedEndpoint,
    #[error("advertised UDP endpoint must be usable unicast with a non-zero port")]
    InvalidAdvertisedEndpoint,
    #[error("resolver must be a usable address inside the Tunnel pool")]
    InvalidAddressPool,
    #[error("flow limits are invalid")]
    InvalidFlowLimits,
    #[error("TUN name is invalid")]
    InvalidTunName,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_values(env::vars().collect())
    }

    pub fn from_values(values: HashMap<String, String>) -> Result<Self, ConfigError> {
        let database_url = required(&values, "ANTNEST_EGRESS_DATABASE_URL")?;
        let development_secret_warnings = check_development_secrets(&values, &database_url)?;
        let database_tls_mode = match values
            .get("ANTNEST_EGRESS_DATABASE_TLS_MODE")
            .map(String::as_str)
            .unwrap_or("require")
        {
            "require" => DatabaseTlsMode::Require,
            "disable" => DatabaseTlsMode::Disable,
            _ => {
                return Err(ConfigError::Invalid("ANTNEST_EGRESS_DATABASE_TLS_MODE"));
            }
        };
        let database_startup_timeout =
            parse_duration(&values, "ANTNEST_EGRESS_DATABASE_STARTUP_TIMEOUT", "30s")?;
        let database_retry_delay =
            parse_duration(&values, "ANTNEST_EGRESS_DATABASE_RETRY_DELAY", "250ms")?;
        let control_listen: SocketAddrV4 =
            parse(&values, "ANTNEST_EGRESS_CONTROL_LISTEN", "127.0.0.1:8081")?;
        if control_listen.ip().is_unspecified()
            || control_listen.ip().is_multicast()
            || control_listen.ip().is_broadcast()
            || control_listen.port() == 0
        {
            return Err(ConfigError::Invalid("ANTNEST_EGRESS_CONTROL_LISTEN"));
        }
        let udp_advertise: SocketAddrV4 = required(&values, "ANTNEST_EGRESS_UDP_ADVERTISE")?
            .parse()
            .map_err(|_| ConfigError::Invalid("ANTNEST_EGRESS_UDP_ADVERTISE"))?;
        if udp_advertise.ip().is_unspecified() {
            return Err(ConfigError::UnspecifiedAdvertisedEndpoint);
        }
        if udp_advertise.port() == 0
            || udp_advertise.ip().is_multicast()
            || udp_advertise.ip().is_broadcast()
        {
            return Err(ConfigError::InvalidAdvertisedEndpoint);
        }
        if control_listen.ip() == udp_advertise.ip() {
            return Err(ConfigError::Invalid("ANTNEST_EGRESS_CONTROL_LISTEN"));
        }
        let health_listen = health_listen_from_values(&values)?;
        if health_listen == control_listen {
            return Err(ConfigError::Invalid("ANTNEST_EGRESS_HEALTH_LISTEN"));
        }
        let tunnel_cidr = parse(&values, "ANTNEST_EGRESS_TUNNEL_CIDR", "100.64.0.0/10")?;
        let resolver_ipv4 = parse(&values, "ANTNEST_EGRESS_RESOLVER_IPV4", "100.64.0.1")?;
        if AddressPool::new("validation", tunnel_cidr, resolver_ipv4, 1).is_err() {
            return Err(ConfigError::InvalidAddressPool);
        }
        let quarantine = parse_duration(&values, "ANTNEST_EGRESS_QUARANTINE", "5m")?;
        let max_flows = parse(&values, "ANTNEST_EGRESS_MAX_FLOWS", "65536")?;
        let max_agent_flows = parse(&values, "ANTNEST_EGRESS_MAX_AGENT_FLOWS", "1024")?;
        if max_flows == 0 || max_agent_flows == 0 || max_agent_flows > max_flows {
            return Err(ConfigError::InvalidFlowLimits);
        }
        let flow_idle = parse_duration(&values, "ANTNEST_EGRESS_FLOW_IDLE", "5m")?;
        let dns_upstream = required(&values, "ANTNEST_EGRESS_DNS_UPSTREAM")?
            .parse()
            .map_err(|_| ConfigError::Invalid("ANTNEST_EGRESS_DNS_UPSTREAM"))?;
        let tun_name = values
            .get("ANTNEST_EGRESS_TUN_NAME")
            .cloned()
            .unwrap_or_else(|| "antnest-egress0".to_owned());
        if tun_name.is_empty()
            || tun_name.len() > 15
            || !tun_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ConfigError::InvalidTunName);
        }
        let command_timeout = parse_duration(&values, "ANTNEST_EGRESS_COMMAND_TIMEOUT", "5s")?;
        Ok(Self {
            database_url,
            development_secret_warnings,
            database_tls_mode,
            database_startup_timeout,
            database_retry_delay,
            control_listen,
            health_listen,
            udp_advertise,
            tunnel_cidr,
            resolver_ipv4,
            quarantine,
            max_flows,
            max_agent_flows,
            flow_idle,
            dns_upstream,
            tun_name,
            command_timeout,
        })
    }
}

fn check_development_secrets(
    values: &HashMap<String, String>,
    database_url: &str,
) -> Result<Vec<&'static str>, ConfigError> {
    let allow = match values
        .get("ANTNEST_ALLOW_PUBLIC_DEV_SECRETS")
        .map(String::as_str)
    {
        None | Some("") | Some("false") => false,
        Some("true") => true,
        _ => return Err(ConfigError::Invalid("ANTNEST_ALLOW_PUBLIC_DEV_SECRETS")),
    };
    let config = database_url
        .parse::<tokio_postgres::Config>()
        .map_err(|_| ConfigError::Invalid("ANTNEST_EGRESS_DATABASE_URL"))?;
    let published = config.get_password().is_some_and(|password| {
        [
            "antnest-postgres-dev",
            "antnest-egress-dev",
            "antnest-runtime-controller-dev",
            "antnest-agent-acp-dev",
            "antnest-identity-dev",
            "antnest-agent-controller-dev",
            "antnest-skill-registry-dev",
            "antnest-temporal-dev",
            "antnest-admin-dev",
            "antnest-skill-registry-local-development-token",
        ]
        .iter()
        .any(|value| password == value.as_bytes())
    });
    if !published {
        return Ok(Vec::new());
    }
    if !allow {
        return Err(ConfigError::PublishedDevelopmentValue(
            "ANTNEST_EGRESS_DATABASE_URL",
        ));
    }
    Ok(vec!["ANTNEST_EGRESS_DATABASE_URL"])
}

pub fn health_listen_from_env() -> Result<SocketAddrV4, ConfigError> {
    health_listen_from_values(&env::vars().collect())
}

pub fn health_listen_from_values(
    values: &HashMap<String, String>,
) -> Result<SocketAddrV4, ConfigError> {
    let endpoint: SocketAddrV4 = parse(values, "ANTNEST_EGRESS_HEALTH_LISTEN", "127.0.0.1:8082")?;
    if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
        return Err(ConfigError::Invalid("ANTNEST_EGRESS_HEALTH_LISTEN"));
    }
    Ok(endpoint)
}

fn required(values: &HashMap<String, String>, name: &'static str) -> Result<String, ConfigError> {
    values
        .get(name)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or(ConfigError::Missing(name))
}

fn parse<T>(
    values: &HashMap<String, String>,
    name: &'static str,
    default: &str,
) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
{
    values
        .get(name)
        .map(String::as_str)
        .unwrap_or(default)
        .parse()
        .map_err(|_| ConfigError::Invalid(name))
}

fn parse_duration(
    values: &HashMap<String, String>,
    name: &'static str,
    default: &str,
) -> Result<Duration, ConfigError> {
    let value = values.get(name).map(String::as_str).unwrap_or(default);
    let split = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    let (amount, unit) = value.split_at(split);
    let amount: u64 = amount.parse().map_err(|_| ConfigError::Invalid(name))?;
    if amount == 0 {
        return Err(ConfigError::Invalid(name));
    }
    match unit {
        "ms" => Ok(Duration::from_millis(amount)),
        "s" | "" => Ok(Duration::from_secs(amount)),
        "m" => amount
            .checked_mul(60)
            .map(Duration::from_secs)
            .ok_or(ConfigError::Invalid(name)),
        "h" => amount
            .checked_mul(3600)
            .map(Duration::from_secs)
            .ok_or(ConfigError::Invalid(name)),
        _ => Err(ConfigError::Invalid(name)),
    }
}
