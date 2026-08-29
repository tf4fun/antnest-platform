use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::execution;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RootName {
    Workspace,
    SystemSkills,
}

impl From<RootName> for execution::RootName {
    fn from(value: RootName) -> Self {
        match value {
            RootName::Workspace => Self::Workspace,
            RootName::SystemSkills => Self::SystemSkills,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RootPath {
    /// Named root. Runtime write/edit operations accept only `workspace`.
    pub(crate) root: RootName,
    /// Non-empty relative path beneath the named root; absolute paths, NUL,
    /// `..`, and platform prefixes are rejected.
    #[schemars(length(min = 1))]
    pub(crate) path: String,
}

impl TryFrom<RootPath> for execution::RootPath {
    type Error = &'static str;

    fn try_from(value: RootPath) -> Result<Self, Self::Error> {
        execution::RootPath::new(value.root.into(), value.path)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EnvironmentVariable {
    #[schemars(length(min = 1))]
    pub(crate) name: String,
    pub(crate) value: String,
}

impl From<EnvironmentVariable> for execution::EnvironmentVariable {
    fn from(value: EnvironmentVariable) -> Self {
        Self::new(value.name, value.value)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BashInput {
    /// Shell command executed with `/bin/bash -lc`.
    #[schemars(length(min = 1))]
    pub(crate) command: String,
    /// Working directory beneath the workspace root.
    pub(crate) working_dir: RootPath,
    /// Additional environment variables for this command only. `HOME` and
    /// `PATH` remain Runtime-owned and duplicate names are rejected.
    #[serde(default)]
    pub(crate) env: Vec<EnvironmentVariable>,
    /// Hard execution deadline in milliseconds.
    #[schemars(range(min = 1, max = 86400000))]
    pub(crate) timeout_ms: u64,
}

impl TryFrom<BashInput> for execution::BashRequest {
    type Error = &'static str;

    fn try_from(value: BashInput) -> Result<Self, Self::Error> {
        execution::BashRequest::new(
            value.command,
            value.working_dir.try_into()?,
            value.env.into_iter().map(Into::into).collect(),
            value.timeout_ms,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub(crate) struct BashResult {
    pub(crate) exit_code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) truncated: bool,
}

impl From<execution::BashResult> for BashResult {
    fn from(value: execution::BashResult) -> Self {
        Self {
            exit_code: value.exit_code,
            stdout: value.stdout,
            stderr: value.stderr,
            truncated: value.truncated,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadFileInput {
    pub(crate) path: RootPath,
    /// Zero-based UTF-8 byte offset.
    #[serde(default)]
    #[schemars(range(min = 0))]
    pub(crate) offset: i64,
    /// Maximum number of bytes returned.
    #[schemars(range(min = 1, max = 8388608))]
    pub(crate) limit: i64,
}

impl TryFrom<ReadFileInput> for execution::ReadRequest {
    type Error = &'static str;

    fn try_from(value: ReadFileInput) -> Result<Self, Self::Error> {
        execution::ReadRequest::new(value.path.try_into()?, value.offset, value.limit)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub(crate) struct ReadFileResult {
    pub(crate) content: String,
    pub(crate) truncated: bool,
}

impl From<execution::ReadResult> for ReadFileResult {
    fn from(value: execution::ReadResult) -> Self {
        Self {
            content: value.content,
            truncated: value.truncated,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteFileInput {
    pub(crate) path: RootPath,
    /// UTF-8 text replacing the complete file. Maximum encoded size is 8 MiB.
    pub(crate) content: String,
}

impl TryFrom<WriteFileInput> for execution::WriteRequest {
    type Error = &'static str;

    fn try_from(value: WriteFileInput) -> Result<Self, Self::Error> {
        execution::WriteRequest::new(value.path.try_into()?, value.content)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub(crate) struct WriteFileResult {
    pub(crate) bytes_written: u64,
}

impl From<execution::WriteResult> for WriteFileResult {
    fn from(value: execution::WriteResult) -> Self {
        Self {
            bytes_written: value.bytes_written,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditFileInput {
    pub(crate) path: RootPath,
    /// Text that must occur exactly once.
    #[schemars(length(min = 1, max = 8388608))]
    pub(crate) old_string: String,
    /// Replacement text. Maximum encoded size is 8 MiB.
    pub(crate) new_string: String,
}

impl TryFrom<EditFileInput> for execution::EditRequest {
    type Error = &'static str;

    fn try_from(value: EditFileInput) -> Result<Self, Self::Error> {
        execution::EditRequest::new(value.path.try_into()?, value.old_string, value.new_string)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub(crate) struct EditFileResult {
    pub(crate) bytes_written: u64,
}

impl From<execution::EditResult> for EditFileResult {
    fn from(value: execution::EditResult) -> Self {
        Self {
            bytes_written: value.bytes_written,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_inputs_cannot_bypass_execution_invariants() {
        let path = RootPath {
            root: RootName::Workspace,
            path: "../outside".into(),
        };
        assert!(execution::RootPath::try_from(path).is_err());

        let bash = BashInput {
            command: "true".into(),
            working_dir: RootPath {
                root: RootName::Workspace,
                path: ".".into(),
            },
            env: vec![EnvironmentVariable {
                name: "HOME".into(),
                value: "/tmp".into(),
            }],
            timeout_ms: 1000,
        };
        assert!(execution::BashRequest::try_from(bash).is_err());
    }
}
