use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::execution;
use crate::information::RuntimeContext;
use crate::tool_error::{ToolError, ToolErrorCode};

pub(crate) const MAX_EXECUTOR_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_EXECUTOR_DIAGNOSTIC_BYTES: usize = 64 * 1024;

pub(crate) fn decode_info_request(input: &[u8]) -> Result<(), ToolError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct InformationRequest {}

    decode_request::<InformationRequest>(input).map(|_| ())
}

pub(crate) fn encode_info_reply(
    result: Result<RuntimeContext, ToolError>,
) -> Result<Vec<u8>, serde_json::Error> {
    encode_reply(result)
}

pub(crate) fn decode_info_reply(
    input: &[u8],
) -> Result<Result<RuntimeContext, ExecutorFailure>, serde_json::Error> {
    decode_reply(input, std::convert::identity)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum ExecutorReply<T> {
    Success { result: T },
    Failure { error: ExecutorFailure },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExecutorFailure {
    pub(crate) code: ToolErrorCode,
    pub(crate) message: String,
    pub(crate) outcome: Outcome,
}

impl ExecutorFailure {
    pub(crate) fn known(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            outcome: Outcome::Known,
        }
    }

    pub(crate) fn unknown(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            outcome: Outcome::Unknown,
        }
    }

    pub(crate) fn into_tool_error(self) -> ToolError {
        match self.outcome {
            Outcome::Known => ToolError::new(self.code, self.message),
            Outcome::Unknown => ToolError::unknown(self.code, self.message),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Known,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireRootName {
    Workspace,
    SystemSkills,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireRootPath {
    root: WireRootName,
    path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireEnvironmentVariable {
    name: String,
    value: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireBashRequest {
    command: String,
    working_dir: WireRootPath,
    env: Vec<WireEnvironmentVariable>,
    timeout_ms: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireReadRequest {
    path: WireRootPath,
    offset: i64,
    limit: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireWriteRequest {
    path: WireRootPath,
    content: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireEditRequest {
    path: WireRootPath,
    old_string: String,
    new_string: String,
}

#[derive(Deserialize, Serialize)]
struct WireBashResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    truncated: bool,
}

#[derive(Deserialize, Serialize)]
struct WireReadResult {
    content: String,
    truncated: bool,
}

#[derive(Deserialize, Serialize)]
struct WireWriteResult {
    bytes_written: u64,
}

#[derive(Deserialize, Serialize)]
struct WireEditResult {
    bytes_written: u64,
}

pub(crate) fn encode_bash_request(
    request: execution::BashRequest,
) -> Result<Vec<u8>, serde_json::Error> {
    let (command, working_dir, env, timeout) = request.into_parts();
    encode(&WireBashRequest {
        command,
        working_dir: encode_path(working_dir),
        env: env
            .into_iter()
            .map(|variable| {
                let (name, value) = variable.into_parts();
                WireEnvironmentVariable { name, value }
            })
            .collect(),
        timeout_ms: u64::try_from(timeout.as_millis())
            .expect("validated Bash timeout always fits u64"),
    })
}

pub(crate) fn decode_bash_request(input: &[u8]) -> Result<execution::BashRequest, ToolError> {
    let wire: WireBashRequest = decode_request(input)?;
    execution::BashRequest::new(
        wire.command,
        decode_path(wire.working_dir)?,
        wire.env
            .into_iter()
            .map(|variable| execution::EnvironmentVariable::new(variable.name, variable.value))
            .collect(),
        wire.timeout_ms,
    )
    .map_err(ToolError::invalid_params)
}

pub(crate) fn encode_read_request(
    request: execution::ReadRequest,
) -> Result<Vec<u8>, serde_json::Error> {
    let (path, offset, limit) = request.into_parts();
    encode(&WireReadRequest {
        path: encode_path(path),
        offset: i64::try_from(offset).expect("validated read offset always fits i64"),
        limit: i64::try_from(limit).expect("validated read limit always fits i64"),
    })
}

pub(crate) fn decode_read_request(input: &[u8]) -> Result<execution::ReadRequest, ToolError> {
    let wire: WireReadRequest = decode_request(input)?;
    execution::ReadRequest::new(decode_path(wire.path)?, wire.offset, wire.limit)
        .map_err(ToolError::invalid_params)
}

pub(crate) fn encode_write_request(
    request: execution::WriteRequest,
) -> Result<Vec<u8>, serde_json::Error> {
    let (path, content) = request.into_parts();
    encode(&WireWriteRequest {
        path: encode_path(path),
        content,
    })
}

pub(crate) fn decode_write_request(input: &[u8]) -> Result<execution::WriteRequest, ToolError> {
    let wire: WireWriteRequest = decode_request(input)?;
    execution::WriteRequest::new(decode_path(wire.path)?, wire.content)
        .map_err(ToolError::invalid_params)
}

pub(crate) fn encode_edit_request(
    request: execution::EditRequest,
) -> Result<Vec<u8>, serde_json::Error> {
    let (path, old_string, new_string) = request.into_parts();
    encode(&WireEditRequest {
        path: encode_path(path),
        old_string,
        new_string,
    })
}

pub(crate) fn decode_edit_request(input: &[u8]) -> Result<execution::EditRequest, ToolError> {
    let wire: WireEditRequest = decode_request(input)?;
    execution::EditRequest::new(decode_path(wire.path)?, wire.old_string, wire.new_string)
        .map_err(ToolError::invalid_params)
}

pub(crate) fn encode_bash_reply(
    result: Result<execution::BashResult, ToolError>,
) -> Result<Vec<u8>, serde_json::Error> {
    encode_reply(result.map(|result| WireBashResult {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
    }))
}

pub(crate) fn decode_bash_reply(
    input: &[u8],
) -> Result<Result<execution::BashResult, ExecutorFailure>, serde_json::Error> {
    decode_reply(input, |result: WireBashResult| execution::BashResult {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
    })
}

pub(crate) fn encode_read_reply(
    result: Result<execution::ReadResult, ToolError>,
) -> Result<Vec<u8>, serde_json::Error> {
    encode_reply(result.map(|result| WireReadResult {
        content: result.content,
        truncated: result.truncated,
    }))
}

pub(crate) fn decode_read_reply(
    input: &[u8],
) -> Result<Result<execution::ReadResult, ExecutorFailure>, serde_json::Error> {
    decode_reply(input, |result: WireReadResult| execution::ReadResult {
        content: result.content,
        truncated: result.truncated,
    })
}

pub(crate) fn encode_write_reply(
    result: Result<execution::WriteResult, ToolError>,
) -> Result<Vec<u8>, serde_json::Error> {
    encode_reply(result.map(|result| WireWriteResult {
        bytes_written: result.bytes_written,
    }))
}

pub(crate) fn decode_write_reply(
    input: &[u8],
) -> Result<Result<execution::WriteResult, ExecutorFailure>, serde_json::Error> {
    decode_reply(input, |result: WireWriteResult| execution::WriteResult {
        bytes_written: result.bytes_written,
    })
}

pub(crate) fn encode_edit_reply(
    result: Result<execution::EditResult, ToolError>,
) -> Result<Vec<u8>, serde_json::Error> {
    encode_reply(result.map(|result| WireEditResult {
        bytes_written: result.bytes_written,
    }))
}

pub(crate) fn decode_edit_reply(
    input: &[u8],
) -> Result<Result<execution::EditResult, ExecutorFailure>, serde_json::Error> {
    decode_reply(input, |result: WireEditResult| execution::EditResult {
        bytes_written: result.bytes_written,
    })
}

fn encode_path(path: execution::RootPath) -> WireRootPath {
    let (root, path) = path.into_parts();
    WireRootPath {
        root: match root {
            execution::RootName::Workspace => WireRootName::Workspace,
            execution::RootName::SystemSkills => WireRootName::SystemSkills,
        },
        path,
    }
}

fn decode_path(path: WireRootPath) -> Result<execution::RootPath, ToolError> {
    let root = match path.root {
        WireRootName::Workspace => execution::RootName::Workspace,
        WireRootName::SystemSkills => execution::RootName::SystemSkills,
    };
    execution::RootPath::new(root, path.path).map_err(ToolError::invalid_params)
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(value)
}

fn decode_request<T: DeserializeOwned>(input: &[u8]) -> Result<T, ToolError> {
    serde_json::from_slice(input).map_err(ToolError::invalid_params)
}

fn encode_reply<T: Serialize>(result: Result<T, ToolError>) -> Result<Vec<u8>, serde_json::Error> {
    let reply = match result {
        Ok(result) => ExecutorReply::Success { result },
        Err(error) => {
            let failure = match error.effect_state {
                crate::tool_error::ToolEffectState::Unknown => {
                    ExecutorFailure::unknown(error.code, error.message)
                }
                crate::tool_error::ToolEffectState::None
                | crate::tool_error::ToolEffectState::Settled => {
                    ExecutorFailure::known(error.code, error.message)
                }
            };
            ExecutorReply::Failure { error: failure }
        }
    };
    encode(&reply)
}

fn decode_reply<T, O>(
    input: &[u8],
    convert: impl FnOnce(T) -> O,
) -> Result<Result<O, ExecutorFailure>, serde_json::Error>
where
    T: DeserializeOwned,
{
    match serde_json::from_slice::<ExecutorReply<T>>(input)? {
        ExecutorReply::Success { result } => Ok(Ok(convert(result))),
        ExecutorReply::Failure { error } => Ok(Err(error)),
    }
}

#[cfg(test)]
mod tests {
    use crate::execution::{
        BashRequest, EditRequest, EnvironmentVariable, ReadRequest, ReadResult, RootName, RootPath,
        WriteRequest,
    };
    use crate::tool_error::{ToolEffectState, ToolError, ToolErrorCode};

    use super::{
        Outcome, decode_bash_request, decode_edit_request, decode_read_reply, decode_read_request,
        decode_write_reply, decode_write_request, encode_bash_request, encode_edit_request,
        encode_read_reply, encode_read_request, encode_write_reply, encode_write_request,
    };

    #[test]
    fn private_codec_round_trips_transport_neutral_execution_requests() {
        let path = || RootPath::new(RootName::Workspace, "notes.txt".into()).unwrap();
        let bash = BashRequest::new(
            "printf hello".into(),
            RootPath::new(RootName::Workspace, ".".into()).unwrap(),
            vec![EnvironmentVariable::new("LANG".into(), "C.UTF-8".into())],
            1000,
        )
        .unwrap();
        let read = ReadRequest::new(path(), 0, 32).unwrap();
        let write = WriteRequest::new(path(), "hello".into()).unwrap();
        let edit = EditRequest::new(path(), "hello".into(), "world".into()).unwrap();

        assert_eq!(
            decode_bash_request(&encode_bash_request(bash.clone()).unwrap()).unwrap(),
            bash
        );
        assert_eq!(
            decode_read_request(&encode_read_request(read.clone()).unwrap()).unwrap(),
            read
        );
        assert_eq!(
            decode_write_request(&encode_write_request(write.clone()).unwrap()).unwrap(),
            write
        );
        assert_eq!(
            decode_edit_request(&encode_edit_request(edit.clone()).unwrap()).unwrap(),
            edit
        );
    }

    #[test]
    fn private_codec_preserves_registered_errors_and_rejects_unknown_codes() {
        let encoded = encode_read_reply(Err(ToolError::new(
            ToolErrorCode::ReadFailed,
            "read failed",
        )))
        .unwrap();
        let failure = decode_read_reply(&encoded).unwrap().unwrap_err();
        assert_eq!(failure.code, ToolErrorCode::ReadFailed);
        assert_eq!(failure.outcome, Outcome::Known);

        let encoded = encode_write_reply(Err(ToolError::outcome_unknown(
            "write may have committed before the executor response was lost",
        )))
        .unwrap();
        let failure = decode_write_reply(&encoded).unwrap().unwrap_err();
        assert_eq!(failure.code, ToolErrorCode::OutcomeUnknown);
        assert_eq!(failure.outcome, Outcome::Unknown);
        assert_eq!(
            failure.into_tool_error().effect_state,
            ToolEffectState::Unknown
        );

        let unknown =
            br#"{"status":"failure","error":{"code":"made_up","message":"bad","outcome":"known"}}"#;
        assert!(decode_read_reply(unknown).is_err());

        let encoded = encode_read_reply(Ok(ReadResult {
            content: "hello".into(),
            truncated: false,
        }))
        .unwrap();
        assert_eq!(
            decode_read_reply(&encoded).unwrap().unwrap().content,
            "hello"
        );
    }
}
