use std::net::Ipv4Addr;

use ipnet::Ipv4Net;
use serde::{Deserialize, Deserializer, Serialize, de};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyAction {
    AllowAll,
    DenyAll,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct PolicySpec {
    schema_version: u32,
    action: PolicyAction,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPolicySpec {
    schema_version: u32,
    action: RawPolicyAction,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawPolicyAction {
    AllowAll,
    DenyAll,
}

impl<'de> Deserialize<'de> for PolicySpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawPolicySpec::deserialize(deserializer)?;
        if raw.schema_version != 1 {
            return Err(de::Error::custom("unsupported policy schema version"));
        }
        Ok(Self {
            schema_version: 1,
            action: match raw.action {
                RawPolicyAction::AllowAll => PolicyAction::AllowAll,
                RawPolicyAction::DenyAll => PolicyAction::DenyAll,
            },
        })
    }
}

impl PolicySpec {
    pub const fn allow_all() -> Self {
        Self {
            schema_version: 1,
            action: PolicyAction::AllowAll,
        }
    }

    pub const fn deny_all() -> Self {
        Self {
            schema_version: 1,
            action: PolicyAction::DenyAll,
        }
    }

    pub const fn schema_version(self) -> u32 {
        self.schema_version
    }

    pub const fn action(self) -> PolicyAction {
        self.action
    }

    pub const fn compile(self, resolver_ipv4: Ipv4Addr) -> CompiledPolicy {
        CompiledPolicy {
            decision: match self.action {
                PolicyAction::AllowAll => Decision::Allow,
                PolicyAction::DenyAll => Decision::Deny,
            },
            resolver_ipv4,
        }
    }

    pub fn for_assignment(assignment: Option<&Self>, resolver_ipv4: Ipv4Addr) -> CompiledPolicy {
        assignment
            .copied()
            .unwrap_or_else(Self::deny_all)
            .compile(resolver_ipv4)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompiledPolicy {
    decision: Decision,
    resolver_ipv4: Ipv4Addr,
}

impl CompiledPolicy {
    pub fn decide(self, destination: Ipv4Addr, destination_port: u16) -> Decision {
        if self.decision == Decision::Deny {
            return Decision::Deny;
        }
        if destination == self.resolver_ipv4 && destination_port == 53 {
            return Decision::Allow;
        }
        if is_external_ipv4(destination) {
            Decision::Allow
        } else {
            Decision::Deny
        }
    }
}

pub const PROTECTED_IPV4_NETWORKS: &[Ipv4Net] = &[
    Ipv4Net::new_assert(Ipv4Addr::new(0, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(10, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(100, 64, 0, 0), 10),
    Ipv4Net::new_assert(Ipv4Addr::new(127, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(169, 254, 0, 0), 16),
    Ipv4Net::new_assert(Ipv4Addr::new(172, 16, 0, 0), 12),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 0, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 2, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 88, 99, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 168, 0, 0), 16),
    Ipv4Net::new_assert(Ipv4Addr::new(198, 18, 0, 0), 15),
    Ipv4Net::new_assert(Ipv4Addr::new(198, 51, 100, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(203, 0, 113, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(224, 0, 0, 0), 4),
    Ipv4Net::new_assert(Ipv4Addr::new(240, 0, 0, 0), 4),
];

pub fn is_external_ipv4(address: Ipv4Addr) -> bool {
    !PROTECTED_IPV4_NETWORKS
        .iter()
        .any(|network| network.contains(&address))
}
