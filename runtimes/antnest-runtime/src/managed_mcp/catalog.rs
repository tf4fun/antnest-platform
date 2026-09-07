use crate::tool_error::{ToolError, ToolErrorCode};
use rmcp::{
    Peer, RoleClient,
    model::{
        CallToolRequestParams, CallToolResult, ClientRequest, PaginatedRequestParams, Request,
        ServerResult, Tool,
    },
    service::PeerRequestOptions,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

const MAX_TOOLS: usize = 128;
const MAX_CATALOG_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct Binding {
    tool: Tool,
    original_name: String,
    peer: Peer<RoleClient>,
}

#[derive(Clone, Default)]
pub(crate) struct Catalog {
    bindings: Arc<BTreeMap<String, Binding>>,
    unavailable: CancellationToken,
}

impl Catalog {
    pub(crate) fn get(&self, name: &str) -> Option<Tool> {
        self.bindings.get(name).map(|binding| binding.tool.clone())
    }

    pub(crate) fn tools(&self) -> Vec<Tool> {
        self.bindings
            .values()
            .map(|binding| binding.tool.clone())
            .collect()
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.bindings.contains_key(name)
    }

    pub(crate) fn healthy(&self) -> bool {
        !self.unavailable.is_cancelled()
            && self
                .bindings
                .values()
                .all(|binding| !binding.peer.is_transport_closed())
    }

    pub(super) fn unavailable(&self) -> CancellationToken {
        self.unavailable.clone()
    }

    pub(crate) async fn add_server(
        &mut self,
        id: &str,
        peer: Peer<RoleClient>,
    ) -> Result<(), &'static str> {
        if peer
            .peer_info()
            .is_none_or(|info| info.capabilities.tools.is_none())
        {
            return Err("managed server does not provide tools");
        }
        let mut candidate = (*self.bindings).clone();
        let mut cursor = None;
        for _ in 0..16 {
            let mut params = PaginatedRequestParams::default();
            params.cursor = cursor;
            let page = peer
                .list_tools(Some(params))
                .await
                .map_err(|_| "managed tool discovery failed")?;
            for mut tool in page.tools {
                let original_name = tool.name.to_string();
                let exposed = exposed_name(id, &original_name)?;
                tool.name = exposed.clone().into();
                if candidate
                    .insert(
                        exposed,
                        Binding {
                            tool,
                            original_name,
                            peer: peer.clone(),
                        },
                    )
                    .is_some()
                {
                    return Err("duplicate managed tool binding");
                }
                if candidate.len() > MAX_TOOLS {
                    return Err("managed tool catalog exceeds 128 tools");
                }
            }
            let tools: Vec<_> = candidate.values().map(|binding| &binding.tool).collect();
            if serde_json::to_vec(&tools)
                .map_err(|_| "invalid managed tool catalog")?
                .len()
                > MAX_CATALOG_BYTES
            {
                return Err("managed tool catalog exceeds 1 MiB");
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                self.bindings = Arc::new(candidate);
                return Ok(());
            }
        }
        Err("managed tool discovery pagination limit exceeded")
    }

    pub(crate) async fn call(
        &self,
        name: &str,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<CallToolResult, ToolError> {
        let binding = self
            .bindings
            .get(name)
            .ok_or_else(|| ToolError::invalid_params("Unknown managed tool"))?;
        if cancel.is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Canceled,
                "managed call canceled before dispatch",
            ));
        }
        if !self.healthy() {
            return Err(ToolError::new(
                ToolErrorCode::RuntimeUnavailable,
                "managed service unavailable",
            ));
        }
        let mut input = CallToolRequestParams::new(binding.original_name.clone());
        input.arguments = arguments;
        let request = ClientRequest::CallToolRequest(Request::new(input));
        let deadline = tokio::time::Instant::now() + timeout;
        // No progress watchers or subscription state are requested: this is one
        // bounded tools/call, not a transparent server-initiated protocol bridge.
        let mut handle = tokio::select! {
            result = binding
                .peer
                .send_cancellable_request(request, PeerRequestOptions::no_options()) => {
                    result.map_err(|_| ToolError::outcome_unknown("managed dispatch failed"))?
                },
            _ = cancel.cancelled() => return Err(ToolError::outcome_unknown("managed dispatch interrupted")),
            _ = tokio::time::sleep_until(deadline) => return Err(ToolError::outcome_unknown("managed dispatch timed out")),
        };
        let response = tokio::select! {
            result = &mut handle.rx => Some(result),
            _ = cancel.cancelled() => None,
            _ = tokio::time::sleep_until(deadline) => None,
        };
        let Some(response) = response else {
            let sent = matches!(
                tokio::time::timeout(
                    Duration::from_secs(1),
                    handle.cancel(Some("Runtime request interrupted".into()))
                )
                .await,
                Ok(Ok(()))
            );
            return Err(ToolError::outcome_unknown(if sent {
                "managed request interrupted; cancellation sent, effects unobserved"
            } else {
                "managed request interrupted; cancellation delivery unconfirmed"
            }));
        };
        match response {
            Ok(Ok(ServerResult::CallToolResult(mut result))) => {
                result.result_type = Some(rmcp::model::ResultType::COMPLETE);
                Ok(result)
            }
            _ => Err(ToolError::outcome_unknown(
                "managed service did not return a completed tool result",
            )),
        }
    }
}

pub(crate) fn exposed_name(server: &str, tool: &str) -> Result<String, &'static str> {
    if tool.is_empty()
        || tool.len() > 128
        || !tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err("invalid managed tool name");
    }
    let name = format!("mcp__{server}__{tool}");
    if name.len() <= 64 && !name.contains('.') {
        return Ok(name);
    }
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
    let prefix = name.replace('.', "_");
    Ok(format!(
        "{}_{:.16}",
        &prefix[..prefix.len().min(47)],
        digest
    ))
}
