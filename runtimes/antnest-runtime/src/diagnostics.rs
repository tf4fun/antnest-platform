use crate::semconv;
use crate::telemetry::TelemetrySpanExt as _;
use crate::tool_error::{ToolError, ToolErrorCode};
use opentelemetry::{Array, KeyValue, Value as OtelValue};
use rmcp::model::{ClientRequest, ServerResult};
use serde::Serialize;
use serde_json::{Value, json};
use std::error::Error as _;

pub(crate) fn rpc_content<T: Serialize>(
    span: &tracing::Span,
    direction: &'static str,
    enabled: bool,
    value: &T,
) {
    if !enabled || span.is_disabled() {
        return;
    }
    match crate::telemetry_contract::capture_rpc_json(value) {
        Ok(encoded) => span.add_contract_event(
            direction,
            vec![KeyValue::new(semconv::ANTNEST_PAYLOAD_JSON, encoded)],
        ),
        Err(_) => span.add_contract_event(
            semconv::ANTNEST_CAPTURE_ERROR,
            vec![KeyValue::new("error.type", "json_encoding")],
        ),
    }
}

fn string_array(values: &[&str]) -> OtelValue {
    OtelValue::Array(Array::String(
        values
            .iter()
            .map(|value| (*value).to_owned().into())
            .collect(),
    ))
}

pub(crate) fn operation(request: &ClientRequest) -> &'static str {
    match request {
        ClientRequest::InitializeRequest(_) => "initialize",
        ClientRequest::DiscoverRequest(_) => "discover",
        ClientRequest::ListToolsRequest(_) => "tools/list",
        ClientRequest::CallToolRequest(_) => "tools/call",
        ClientRequest::ListResourcesRequest(_) => "resources/list",
        ClientRequest::ReadResourceRequest(_) => "resources/read",
        _ => "unsupported",
    }
}

pub(crate) fn primitive_tool(request: &ClientRequest) -> Option<&'static str> {
    let ClientRequest::CallToolRequest(request) = request else {
        return None;
    };
    match request.params.name.as_ref() {
        "bash" => Some("bash"),
        "read" => Some("read"),
        "write" => Some("write"),
        "edit" => Some("edit"),
        _ => None,
    }
}

pub(crate) trait ProtocolResult {
    fn capture(&self, span: &tracing::Span, enabled: bool);
    fn error_code(&self, _tool: Option<&str>) -> Option<&'static str> {
        None
    }
}
macro_rules! plain_result {
    ($($result:ty),+ $(,)?) => { $(
        impl ProtocolResult for $result {
            fn capture(&self, span: &tracing::Span, enabled: bool) {
                rpc_content(span, semconv::ANTNEST_RESPONSE, enabled, self);
            }
        }
    )+ };
}
plain_result!(
    rmcp::model::InitializeResult,
    rmcp::model::DiscoverResult,
    rmcp::model::ListToolsResult,
    rmcp::model::ListResourcesResult,
    rmcp::model::ReadResourceResult,
    ()
);
impl ProtocolResult for rmcp::model::ReadResourceResponse {
    fn capture(&self, span: &tracing::Span, enabled: bool) {
        if enabled && !span.is_disabled() {
            rpc_content(
                span,
                semconv::ANTNEST_RESPONSE,
                true,
                &ServerResult::from(self.clone()),
            );
        }
    }
}
impl ProtocolResult for rmcp::model::CallToolResult {
    fn capture(&self, span: &tracing::Span, enabled: bool) {
        rpc_content(span, semconv::ANTNEST_RESPONSE, enabled, self);
    }
    fn error_code(&self, tool: Option<&str>) -> Option<&'static str> {
        tool_protocol_error(tool, self)
    }
}
impl ProtocolResult for rmcp::model::CallToolResponse {
    fn capture(&self, span: &tracing::Span, enabled: bool) {
        if enabled && !span.is_disabled() {
            rpc_content(
                span,
                semconv::ANTNEST_RESPONSE,
                true,
                &ServerResult::from(self.clone()),
            );
        }
    }
    fn error_code(&self, tool: Option<&str>) -> Option<&'static str> {
        match self {
            Self::Complete(result) => result.error_code(tool),
            _ => None,
        }
    }
}
impl ProtocolResult for ServerResult {
    fn capture(&self, span: &tracing::Span, enabled: bool) {
        rpc_content(span, semconv::ANTNEST_RESPONSE, enabled, self);
    }
    fn error_code(&self, tool: Option<&str>) -> Option<&'static str> {
        match self {
            Self::CallToolResult(result) => result.error_code(tool),
            _ => None,
        }
    }
}

pub(crate) fn protocol_error<T: ProtocolResult>(
    tool: Option<&str>,
    result: &T,
) -> Option<&'static str> {
    result.error_code(tool)
}

fn tool_protocol_error(
    tool: Option<&str>,
    result: &rmcp::model::CallToolResult,
) -> Option<&'static str> {
    if result.is_error != Some(true) {
        return None;
    }
    Some(if tool.is_some() {
        result
            .structured_content
            .as_ref()
            .and_then(|value| value.get("error_code"))
            .and_then(Value::as_str)
            .and_then(ToolErrorCode::parse)
            .map_or("tool_error", ToolErrorCode::as_str)
    } else {
        "managed_tool_error"
    })
}

pub(crate) fn safe_tool_message(code: ToolErrorCode) -> &'static str {
    match code {
        ToolErrorCode::AtomicSkillReplaceUnsupported => "Atomic Skill replacement is unavailable",
        ToolErrorCode::SkillWritersUnknown => "Skill writer ownership could not be proven",
        ToolErrorCode::SkillBackgroundTaskRunning => "A Bash background task is still running",
        ToolErrorCode::SkillManagedCallInFlight => "A managed MCP child is still running",
        ToolErrorCode::SkillStorageFull => "Hidden Skill storage is full",
        ToolErrorCode::TemporaryRunClosed => "Temporary Skill Run scope is closed",
        ToolErrorCode::TemporaryScopeBusy => "Another temporary Skill scope is active",
        ToolErrorCode::TemporaryBackgroundNotSupported => {
            "Background work was stopped because this Run uses temporary Skill files; run it in the foreground or use a durable preset"
        }
        ToolErrorCode::SpawnFailed => "Executor process could not be started",
        ToolErrorCode::ReadFailed | ToolErrorCode::EditReadFailed => "File could not be read",
        ToolErrorCode::WriteFailed | ToolErrorCode::EditFailed => "File mutation failed",
        ToolErrorCode::InvalidPath => "Requested path failed validation or resolution",
        ToolErrorCode::InvalidParams => "Tool parameters failed validation",
        ToolErrorCode::Timeout => "Tool deadline elapsed",
        ToolErrorCode::Canceled => "Tool execution canceled",
        ToolErrorCode::RuntimeBusy => "Runtime is executing another tool call",
        ToolErrorCode::RuntimeUnavailable => "Runtime is not accepting tool calls",
        ToolErrorCode::OutcomeUnknown => "Execution ended without a confirmed effect outcome",
        ToolErrorCode::ChildProcessContainmentUnproven => {
            "Executor containment could not be proven"
        }
        ToolErrorCode::ContentNotUtf8 => "File content is not UTF-8",
        ToolErrorCode::OldStringNotFound => "Edit match was not found",
        ToolErrorCode::OldStringNotUnique => "Edit match was not unique",
        ToolErrorCode::ResultTooLarge => "Tool result exceeded the supported limit",
        ToolErrorCode::EncodeResultFailed => "Tool result encoding failed",
        ToolErrorCode::OutputCaptureFailed => "Executor output capture failed",
        ToolErrorCode::WaitFailed => "Executor process wait failed",
        ToolErrorCode::RuntimeFailed => "Runtime execution adapter failed",
    }
}

pub(crate) fn error_summary(
    span: &tracing::Span,
    stage: &'static str,
    code: &str,
    message: &'static str,
) {
    span.set_contract_attribute("error.type", code.to_owned());
    span.add_contract_event(
        semconv::ANTNEST_ERROR,
        vec![
            KeyValue::new(semconv::ANTNEST_ERROR_STAGE, stage),
            KeyValue::new(semconv::ANTNEST_ERROR_TYPE, code.to_owned()),
            KeyValue::new(semconv::ANTNEST_ERROR_CODE, code.to_owned()),
            KeyValue::new(semconv::ANTNEST_ERROR_MESSAGE, message),
        ],
    );
}

pub(crate) fn tool_error_attributes(stage: &'static str, error: &ToolError) -> Vec<KeyValue> {
    let mut attributes = vec![
        KeyValue::new(semconv::ANTNEST_ERROR_STAGE, stage),
        KeyValue::new(semconv::ANTNEST_ERROR_TYPE, error.code.as_str()),
        KeyValue::new(semconv::ANTNEST_ERROR_CODE, error.code.as_str()),
        KeyValue::new(
            semconv::ANTNEST_ERROR_MESSAGE,
            safe_tool_message(error.code),
        ),
    ];
    let mut source = error.source();
    let mut causes = Vec::new();
    let mut summaries = Vec::new();
    for _ in 0..4 {
        let Some(error) = source else { break };
        let kind = if let Some(error) = error.downcast_ref::<std::io::Error>() {
            if let Some(code) = error.raw_os_error() {
                summaries.push(json!({"type": "io.error", "code": code.to_string()}));
            }
            match error.kind() {
                std::io::ErrorKind::PermissionDenied => "io.permission_denied",
                std::io::ErrorKind::NotFound => "io.not_found",
                std::io::ErrorKind::TimedOut => "io.timed_out",
                std::io::ErrorKind::BrokenPipe => "io.broken_pipe",
                std::io::ErrorKind::UnexpectedEof => "io.unexpected_eof",
                _ => "io.error",
            }
        } else if let Some(error) = error.downcast_ref::<ToolError>() {
            error.code.as_str()
        } else if error.is::<serde_json::Error>() {
            "json.decode_or_encode"
        } else if error.is::<tokio::task::JoinError>() {
            "task.join"
        } else if error.is::<tokio::time::error::Elapsed>() {
            "deadline.elapsed"
        } else if let Some(error) = error.downcast_ref::<rmcp::ServiceError>() {
            match error {
                rmcp::ServiceError::McpError(error) => {
                    attributes.push(KeyValue::new("jsonrpc.error_code", i64::from(error.code.0)));
                    summaries.push(
                        json!({"type": "mcp.protocol_error", "code": error.code.0.to_string()}),
                    );
                    "mcp.protocol_error"
                }
                rmcp::ServiceError::Timeout { .. } => "mcp.timeout",
                rmcp::ServiceError::Cancelled { .. } => "mcp.canceled",
                rmcp::ServiceError::TransportClosed => "mcp.transport_closed",
                rmcp::ServiceError::TransportSend(_) => "mcp.transport_send",
                rmcp::ServiceError::UnexpectedResponse => "mcp.unexpected_response",
                _ => "mcp.service",
            }
        } else {
            "unclassified_source"
        };
        causes.push(kind);
        source = error.source();
    }
    if !causes.is_empty() {
        attributes.push(KeyValue::new(
            semconv::ANTNEST_ERROR_CAUSE_TYPES,
            string_array(&causes),
        ));
    }
    if !summaries.is_empty() {
        attributes.push(KeyValue::new(
            semconv::ANTNEST_ERROR_CAUSES,
            Value::Array(summaries).to_string(),
        ));
    }
    attributes
}

pub(crate) fn record_tool_error(span: &tracing::Span, stage: &'static str, error: &ToolError) {
    span.add_contract_event(semconv::ANTNEST_ERROR, tool_error_attributes(stage, error));
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
