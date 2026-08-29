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

    pub const fn compile(self) -> CompiledPolicy {
        CompiledPolicy {
            decision: match self.action {
                PolicyAction::AllowAll => Decision::Allow,
                PolicyAction::DenyAll => Decision::Deny,
            },
        }
    }

    pub fn for_assignment(assignment: Option<&Self>) -> CompiledPolicy {
        assignment.copied().unwrap_or_else(Self::deny_all).compile()
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
}

impl CompiledPolicy {
    pub const fn decide(self) -> Decision {
        self.decision
    }
}
