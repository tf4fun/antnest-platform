use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::execution;

fn workspace_directory() -> String {
    ".".into()
}
fn bash_timeout() -> u64 {
    120000
}
fn first_line() -> i64 {
    1
}
fn read_lines() -> i64 {
    execution::DEFAULT_READ_LINES as i64
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
    /// Working directory: relative to /workspace or beneath /workspace/.
    /// Defaults to the workspace itself.
    #[serde(default = "workspace_directory")]
    #[schemars(length(min = 1))]
    pub(crate) working_dir: String,
    /// Additional environment variables for this command only. `HOME` and
    /// `PATH` remain Runtime-owned and duplicate names are rejected.
    #[serde(default)]
    pub(crate) env: Vec<EnvironmentVariable>,
    /// Hard execution deadline in milliseconds.
    #[serde(default = "bash_timeout")]
    #[schemars(range(min = 1, max = 86400000))]
    pub(crate) timeout_ms: u64,
}

impl TryFrom<BashInput> for execution::BashRequest {
    type Error = &'static str;

    fn try_from(value: BashInput) -> Result<Self, Self::Error> {
        execution::BashRequest::new(
            value.command,
            execution::RootPath::from_tool_path(value.working_dir)?,
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
    /// File path: relative to /workspace, ~/path, /workspace/path, or /skills/path.
    #[schemars(length(min = 1))]
    pub(crate) path: String,
    /// First line to read (1-indexed; default 1).
    #[serde(default = "first_line")]
    #[schemars(range(min = 1))]
    pub(crate) offset: i64,
    /// Maximum lines to read (default 2000); output is also capped at 50 KiB.
    #[serde(default = "read_lines")]
    #[schemars(range(min = 1, max = 20000))]
    pub(crate) limit: i64,
}

impl TryFrom<ReadFileInput> for execution::ReadRequest {
    type Error = &'static str;

    fn try_from(value: ReadFileInput) -> Result<Self, Self::Error> {
        execution::ReadRequest::new(
            execution::RootPath::from_tool_path(value.path)?,
            value.offset,
            value.limit,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub(crate) struct ReadFileResult {
    pub(crate) content: String,
    pub(crate) truncated: bool,
    /// Next 1-based line to read, or null at the end of the file.
    pub(crate) next_offset: Option<usize>,
}

impl From<execution::ReadResult> for ReadFileResult {
    fn from(value: execution::ReadResult) -> Self {
        Self {
            content: value.content,
            truncated: value.truncated,
            next_offset: value.next_offset,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteFileInput {
    /// File path: relative to /workspace, ~/path, or /workspace/path.
    /// System Skills under /skills/ are read-only.
    #[schemars(length(min = 1))]
    pub(crate) path: String,
    /// UTF-8 text replacing the complete file. Maximum encoded size is 8 MiB.
    pub(crate) content: String,
}

impl TryFrom<WriteFileInput> for execution::WriteRequest {
    type Error = &'static str;

    fn try_from(value: WriteFileInput) -> Result<Self, Self::Error> {
        execution::WriteRequest::new(
            execution::RootPath::from_tool_path(value.path)?,
            value.content,
        )
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
    /// File path: relative to /workspace, ~/path, or /workspace/path.
    /// System Skills under /skills/ are read-only.
    #[schemars(length(min = 1))]
    pub(crate) path: String,
    /// Text that must occur exactly once.
    #[schemars(length(min = 1, max = 8388608))]
    pub(crate) old_string: String,
    /// Replacement text. Maximum encoded size is 8 MiB.
    pub(crate) new_string: String,
}

impl TryFrom<EditFileInput> for execution::EditRequest {
    type Error = &'static str;

    fn try_from(value: EditFileInput) -> Result<Self, Self::Error> {
        execution::EditRequest::new(
            execution::RootPath::from_tool_path(value.path)?,
            value.old_string,
            value.new_string,
        )
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
        assert!(execution::RootPath::from_tool_path("../outside".into()).is_err());

        let bash = BashInput {
            command: "true".into(),
            working_dir: ".".into(),
            env: vec![EnvironmentVariable {
                name: "HOME".into(),
                value: "/tmp".into(),
            }],
            timeout_ms: 1000,
        };
        assert!(execution::BashRequest::try_from(bash).is_err());
    }
}
