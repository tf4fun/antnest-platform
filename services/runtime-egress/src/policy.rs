use std::net::Ipv4Addr;

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

fn is_external_ipv4(address: Ipv4Addr) -> bool {
    !matches!(
        address.octets(),
        [0, _, _, _]
            | [10, _, _, _]
            | [100, 64..=127, _, _]
            | [127, _, _, _]
            | [169, 254, _, _]
            | [172, 16..=31, _, _]
            | [192, 0, 0, _]
            | [192, 0, 2, _]
            | [192, 88, 99, _]
            | [192, 168, _, _]
            | [198, 18..=19, _, _]
            | [198, 51, 100, _]
            | [203, 0, 113, _]
            | [224..=255, _, _, _]
    )
}
