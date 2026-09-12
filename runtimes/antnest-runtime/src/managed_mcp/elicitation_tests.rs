use std::{borrow::Cow, sync::Arc, time::Duration};

use rmcp::{RoleServer, ServerHandler, ServiceExt as _, model::*, service::RequestContext};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{catalog::Catalog, progress::ProgressSource, session};
use crate::tool_error::ToolErrorCode;

fn requirement(params: serde_json::Value) -> serde_json::Value {
    json!({
        "resultType": "input_required",
        "inputRequests": {"answer": {"method": "elicitation/create", "params": params}},
        "requestState": "private-state-canary"
    })
}

#[test]
fn official_sdk_url_gap_keeps_f07_deferred() {
    // Revisit the deferral when this fails on an official SDK upgrade.
    let mut input = requirement(json!({
        "mode": "url", "message": "Authorize access",
        "url": "https://example.com/authorize"
    }));
    assert!(serde_json::from_value::<InputRequiredResult>(input.clone()).is_err());
    input["inputRequests"]["answer"]["params"]["elicitationId"] = json!("legacy-id");
    let typed: InputRequiredResult = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), input);
}

#[test]
fn official_sdk_standard_form_roundtrips_without_a_workaround() {
    let input = requirement(json!({
        "mode": "form", "message": "Select a name",
        "requestedSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 50}},
            "required": ["name"]
        }
    }));
    let typed: InputRequiredResult = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), input);
}

#[derive(Clone)]
struct Fixture {
    version: ProtocolVersion,
}

impl Fixture {
    fn assert_noninteractive(&self, context: &RequestContext<RoleServer>) {
        let capabilities = if self.version == ProtocolVersion::V_2025_11_25 {
            // A legacy implementation reads capabilities from initialize, not inline metadata.
            context.peer.peer_info().unwrap().capabilities.clone()
        } else {
            context.client_capabilities().unwrap()
        };
        assert_eq!(capabilities, ClientCapabilities::default());
    }
}

struct FixtureService(Fixture);

impl rmcp::Service<RoleServer> for FixtureService {
    async fn handle_request(
        &self,
        request: ClientRequest,
        context: RequestContext<RoleServer>,
    ) -> Result<ServerResult, rmcp::ErrorData> {
        if self.0.version == ProtocolVersion::V_2025_11_25 {
            // Emulate a pre-discovery child without the new SDK's inline-meta policy.
            return match request {
                ClientRequest::DiscoverRequest(_) => {
                    Err(rmcp::ErrorData::method_not_found::<DiscoverRequestMethod>())
                }
                ClientRequest::InitializeRequest(request) => {
                    assert!(request.params.capabilities.elicitation.is_none());
                    context.peer.set_peer_info(request.params.clone());
                    self.0
                        .initialize(request.params, context)
                        .await
                        .map(ServerResult::InitializeResult)
                }
                ClientRequest::ListToolsRequest(request) => self
                    .0
                    .list_tools(request.params, context)
                    .await
                    .map(ServerResult::ListToolsResult),
                ClientRequest::CallToolRequest(request) => self
                    .0
                    .call_tool(request.params, context)
                    .await
                    .map(Into::into),
                request => rmcp::Service::handle_request(&self.0, request, context).await,
            };
        }
        rmcp::Service::handle_request(&self.0, request, context).await
    }

    async fn handle_notification(
        &self,
        notification: ClientNotification,
        context: rmcp::service::NotificationContext<RoleServer>,
    ) -> Result<(), rmcp::ErrorData> {
        rmcp::Service::handle_notification(&self.0, notification, context).await
    }

    fn get_info(&self) -> ServerInfo {
        ServerHandler::get_info(&self.0)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        ServerHandler::supported_protocol_versions(&self.0)
    }
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(self.version.clone())
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(vec![self.version.clone()])
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        self.assert_noninteractive(&context);
        Ok(ListToolsResult::with_all_items(vec![Tool::new(
            "check",
            "Non-interactive fixture",
            Arc::new(json!({"type": "object"}).as_object().unwrap().clone()),
        )]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        self.assert_noninteractive(&context);
        if request
            .arguments
            .as_ref()
            .is_some_and(|args| args["ask"] == true)
        {
            let input: InputRequiredResult = serde_json::from_value(requirement(json!({
                "mode": "form", "message": "private-message-canary",
                "requestedSchema": {"type": "object", "properties": {}}
            })))
            .unwrap();
            return Ok(input.into());
        }
        Ok(CallToolResult::structured(json!({"ready": true})).into())
    }
}

#[tokio::test]
async fn sdk_negotiation_preserves_modern_and_legacy_noninteractive_tools() {
    for version in [ProtocolVersion::V_2026_07_28, ProtocolVersion::V_2025_11_25] {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let fixture = Fixture {
            version: version.clone(),
        };
        let server =
            tokio::spawn(async move { FixtureService(fixture).serve(server_io).await.unwrap() });
        let source = ProgressSource::default();
        let (read, write) = tokio::io::split(client_io);
        let mut client = tokio::time::timeout(
            Duration::from_secs(5),
            session::connect(read, write, CancellationToken::new(), source.clone()),
        )
        .await
        .expect("client negotiation timed out")
        .unwrap();
        let mut server = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("fixture initialization timed out")
            .unwrap();
        assert_eq!(client.peer().peer_info().unwrap().protocol_version, version);
        let mut catalog = Catalog::default();
        tokio::time::timeout(
            Duration::from_secs(2),
            catalog.add_server("fixture", client.peer().clone(), source),
        )
        .await
        .expect("discovery timed out")
        .unwrap();

        let result = catalog
            .call(
                "mcp__fixture__check",
                None,
                CancellationToken::new(),
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(result.structured_content.unwrap()["ready"], true);

        if version == ProtocolVersion::V_2026_07_28 {
            let error = catalog
                .call(
                    "mcp__fixture__check",
                    Some(json!({"ask": true}).as_object().unwrap().clone()),
                    CancellationToken::new(),
                    Duration::from_secs(2),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, ToolErrorCode::OutcomeUnknown);
            assert!(!format!("{error:?}").contains("canary"));
            assert!(catalog.healthy());
            let result = catalog
                .call(
                    "mcp__fixture__check",
                    None,
                    CancellationToken::new(),
                    Duration::from_secs(2),
                )
                .await
                .unwrap();
            assert_eq!(result.structured_content.unwrap()["ready"], true);
        }
        tokio::time::timeout(Duration::from_secs(2), client.close())
            .await
            .expect("client shutdown timed out")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), server.close())
            .await
            .expect("fixture shutdown timed out")
            .unwrap();
    }
}
