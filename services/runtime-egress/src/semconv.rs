#![allow(dead_code)]

pub const ANTNEST_ACP_BRIDGE_INTENT_REUSE: &str = "antnest.acp.bridge_intent_reuse";
pub const ANTNEST_ACP_CONNECTIONS: &str = "antnest.acp.connections";
pub const ANTNEST_ACP_MCP_CLOSE_FAILURES: &str = "antnest.acp.mcp.close_failures";
pub const ANTNEST_ACP_MCP_DURATION: &str = "antnest.acp.mcp.duration";
pub const ANTNEST_ACP_MCP_REQUESTS: &str = "antnest.acp.mcp.requests";
pub const ANTNEST_ACP_MODEL_DURATION: &str = "antnest.acp.model.duration";
pub const ANTNEST_ACP_MODEL_REQUESTS: &str = "antnest.acp.model.requests";
pub const ANTNEST_ACP_PERMISSION_DECISIONS: &str = "antnest.acp.permission.decisions";
pub const ANTNEST_ACP_RECOVERY_RUNS: &str = "antnest.acp.recovery_runs";
pub const ANTNEST_ACP_REPOSITORY_DURATION: &str = "antnest.acp.repository.duration";
pub const ANTNEST_ACP_REPOSITORY_REQUESTS: &str = "antnest.acp.repository.requests";
pub const ANTNEST_ACP_RUN_DURATION: &str = "antnest.acp.run.duration";
pub const ANTNEST_ACP_RUN_ADMISSIONS: &str = "antnest.acp.run_admissions";
pub const ANTNEST_ACP_RUNS: &str = "antnest.acp.runs";
pub const ANTNEST_ACP_SESSION_METHOD_DURATION: &str = "antnest.acp.session_method.duration";
pub const ANTNEST_ACP_SESSION_METHODS: &str = "antnest.acp.session_methods";
pub const ANTNEST_ACP_SKILL_LEARNING_TASKS: &str = "antnest.acp.skill_learning.tasks";
pub const ANTNEST_ACP_SKILL_PROJECTIONS: &str = "antnest.acp.skill_projections";
pub const ANTNEST_ACP_SKILL_TEMPORARY_CLEANUP: &str = "antnest.acp.skill_temporary_cleanup";
pub const ANTNEST_ACP_UNRESOLVED_RUNS: &str = "antnest.acp.unresolved_runs";
pub const ANTNEST_ACP_WORKER_LOCK_LOSSES: &str = "antnest.acp.worker_lock_losses";
pub const ANTNEST_ACTOR_ID: &str = "antnest.actor.id";
pub const ANTNEST_ADMISSION_ID: &str = "antnest.admission.id";
pub const ANTNEST_AGENT_ID: &str = "antnest.agent.id";
pub const ANTNEST_AGENT_REVISION: &str = "antnest.agent.revision";
pub const ANTNEST_AGENT_CONTROLLER_DEPENDENCY_DURATION: &str = "antnest.agent_controller.dependency.duration";
pub const ANTNEST_AGENT_CONTROLLER_DEPENDENCY_REQUESTS: &str = "antnest.agent_controller.dependency.requests";
pub const ANTNEST_AGENT_CONTROLLER_EVENT_JOURNAL_APPENDS: &str = "antnest.agent_controller.event_journal.appends";
pub const ANTNEST_AGENT_CONTROLLER_EVENT_NOTIFIER_TRANSITIONS: &str = "antnest.agent_controller.event_notifier.transitions";
pub const ANTNEST_AGENT_CONTROLLER_EVENT_WATCH_CONNECTIONS: &str = "antnest.agent_controller.event_watch.connections";
pub const ANTNEST_AGENT_CONTROLLER_EVENT_WATCH_DISCONNECTS: &str = "antnest.agent_controller.event_watch.disconnects";
pub const ANTNEST_AGENT_CONTROLLER_HTTP_DURATION: &str = "antnest.agent_controller.http.duration";
pub const ANTNEST_AGENT_CONTROLLER_HTTP_REQUESTS: &str = "antnest.agent_controller.http.requests";
pub const ANTNEST_AGENT_CONTROLLER_LIFECYCLE_OPERATIONS: &str = "antnest.agent_controller.lifecycle.operations";
pub const ANTNEST_AGENT_ID_LEGACY: &str = "antnest.agent_id";
pub const ANTNEST_AUTHORIZATION_MODE: &str = "antnest.authorization.mode";
pub const ANTNEST_CANCELLATION_PHASE: &str = "antnest.cancellation.phase";
pub const ANTNEST_CANCELLATION_TYPE: &str = "antnest.cancellation.type";
pub const ANTNEST_CANCELLED: &str = "antnest.cancelled";
pub const ANTNEST_CAPTURE_ERROR: &str = "antnest.capture.error";
pub const ANTNEST_COMPLETE: &str = "antnest.complete";
pub const ANTNEST_CONFIGURATION_APPLIED_REVISION: &str = "antnest.configuration.applied_revision";
pub const ANTNEST_CONFIGURATION_REVISION: &str = "antnest.configuration.revision";
pub const ANTNEST_CONTEXT_MESSAGE_COUNT: &str = "antnest.context.message_count";
pub const ANTNEST_CONTEXT_TOOL_COUNT: &str = "antnest.context.tool_count";
pub const ANTNEST_CONTROLLER_SCOPE: &str = "antnest.controller.scope";
pub const ANTNEST_DEADLINE: &str = "antnest.deadline";
pub const ANTNEST_EGRESS_AGENT_FENCED_PACKETS: &str = "antnest.egress.agent.fenced_packets";
pub const ANTNEST_EGRESS_AGENT_UNKNOWN: &str = "antnest.egress.agent.unknown";
pub const ANTNEST_EGRESS_CONTROL_DURATION: &str = "antnest.egress.control.duration";
pub const ANTNEST_EGRESS_CONTROL_REQUESTS: &str = "antnest.egress.control.requests";
pub const ANTNEST_EGRESS_DNS_ANSWERS_FILTERED: &str = "antnest.egress.dns.answers.filtered";
pub const ANTNEST_EGRESS_DNS_CLIENT_TO_UPSTREAM_BYTES: &str = "antnest.egress.dns.client_to_upstream.bytes";
pub const ANTNEST_EGRESS_DNS_CONNECTIONS_ACCEPTED: &str = "antnest.egress.dns.connections.accepted";
pub const ANTNEST_EGRESS_DNS_CONNECTIONS_COMPLETED: &str = "antnest.egress.dns.connections.completed";
pub const ANTNEST_EGRESS_DNS_CONNECTIONS_REJECTED: &str = "antnest.egress.dns.connections.rejected";
pub const ANTNEST_EGRESS_DNS_PROXY_FAILURES: &str = "antnest.egress.dns.proxy.failures";
pub const ANTNEST_EGRESS_DNS_UPSTREAM_TO_CLIENT_BYTES: &str = "antnest.egress.dns.upstream_to_client.bytes";
pub const ANTNEST_EGRESS_DOWNLINK_BYTES: &str = "antnest.egress.downlink.bytes";
pub const ANTNEST_EGRESS_DOWNLINK_PACKETS: &str = "antnest.egress.downlink.packets";
pub const ANTNEST_EGRESS_FLOW_ACTIVE: &str = "antnest.egress.flow.active";
pub const ANTNEST_EGRESS_FLOW_CAPACITY_REJECTIONS: &str = "antnest.egress.flow.capacity_rejections";
pub const ANTNEST_EGRESS_FLOW_COLLISIONS: &str = "antnest.egress.flow.collisions";
pub const ANTNEST_EGRESS_FLOW_EXPIRATIONS: &str = "antnest.egress.flow.expirations";
pub const ANTNEST_EGRESS_FLOW_REVERSE_MISSES: &str = "antnest.egress.flow.reverse_misses";
pub const ANTNEST_EGRESS_HEALTH_CONTROL_PLANE_READY: &str = "antnest.egress.health.control_plane.ready";
pub const ANTNEST_EGRESS_HEALTH_DATA_PLANE_READY: &str = "antnest.egress.health.data_plane.ready";
pub const ANTNEST_EGRESS_HEALTH_FENCED_AGENTS: &str = "antnest.egress.health.fenced_agents";
pub const ANTNEST_EGRESS_HEALTH_READY: &str = "antnest.egress.health.ready";
pub const ANTNEST_EGRESS_HEALTH_TRANSITIONS: &str = "antnest.egress.health.transitions";
pub const ANTNEST_EGRESS_PACKET_MALFORMED: &str = "antnest.egress.packet.malformed";
pub const ANTNEST_EGRESS_PACKET_UNSUPPORTED: &str = "antnest.egress.packet.unsupported";
pub const ANTNEST_EGRESS_PEER_MISMATCH_DROPS: &str = "antnest.egress.peer_mismatch.drops";
pub const ANTNEST_EGRESS_PEER_OUTPUT_FAILURES: &str = "antnest.egress.peer_output.failures";
pub const ANTNEST_EGRESS_POLICY_ALLOWS: &str = "antnest.egress.policy.allows";
pub const ANTNEST_EGRESS_POLICY_DENIALS: &str = "antnest.egress.policy.denials";
pub const ANTNEST_EGRESS_QUARANTINE_CLEANUP_FAILURES: &str = "antnest.egress.quarantine.cleanup_failures";
pub const ANTNEST_EGRESS_QUARANTINE_REMOVED: &str = "antnest.egress.quarantine.removed";
pub const ANTNEST_EGRESS_TUNNEL_AUTHENTICATION_DROPS: &str = "antnest.egress.tunnel.authentication_drops";
pub const ANTNEST_EGRESS_TUNNEL_REPLAY_DROPS: &str = "antnest.egress.tunnel.replay_drops";
pub const ANTNEST_EGRESS_TUNNEL_UNKNOWN_CONTEXT_DROPS: &str = "antnest.egress.tunnel.unknown_context_drops";
pub const ANTNEST_EGRESS_UDP_RECEIVE_ERRORS_UNATTRIBUTED: &str = "antnest.egress.udp.receive_errors.unattributed";
pub const ANTNEST_EGRESS_UPLINK_BYTES: &str = "antnest.egress.uplink.bytes";
pub const ANTNEST_EGRESS_UPLINK_PACKETS: &str = "antnest.egress.uplink.packets";
pub const ANTNEST_ERROR: &str = "antnest.error";
pub const ANTNEST_ERROR_CAUSE_TYPES: &str = "antnest.error.cause_types";
pub const ANTNEST_ERROR_CAUSES: &str = "antnest.error.causes";
pub const ANTNEST_ERROR_CLASS_LEGACY: &str = "antnest.error.class";
pub const ANTNEST_ERROR_CLASSIFICATION: &str = "antnest.error.classification";
pub const ANTNEST_ERROR_CODE: &str = "antnest.error.code";
pub const ANTNEST_ERROR_MESSAGE: &str = "antnest.error.message";
pub const ANTNEST_ERROR_ORIGIN: &str = "antnest.error.origin";
pub const ANTNEST_ERROR_ORIGIN_SPAN_ID: &str = "antnest.error.origin_span_id";
pub const ANTNEST_ERROR_ORIGIN_TRACE_ID: &str = "antnest.error.origin_trace_id";
pub const ANTNEST_ERROR_PANIC_TYPE: &str = "antnest.error.panic_type";
pub const ANTNEST_ERROR_PROTOCOL_CODE: &str = "antnest.error.protocol_code";
pub const ANTNEST_ERROR_STAGE: &str = "antnest.error.stage";
pub const ANTNEST_ERROR_TYPE: &str = "antnest.error.type";
pub const ANTNEST_EVENT_TYPE: &str = "antnest.event.type";
pub const ANTNEST_EVENT_NOTIFIER_STATE: &str = "antnest.event_notifier.state";
pub const ANTNEST_EVENT_WATCH_SCOPE: &str = "antnest.event_watch.scope";
pub const ANTNEST_EXECUTION_REVISION: &str = "antnest.execution.revision";
pub const ANTNEST_EXECUTION_TIMEOUT_MS: &str = "antnest.execution.timeout_ms";
pub const ANTNEST_FRESH_DATABASE_INSTALL: &str = "antnest.fresh_database_install";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_ACCOUNTED_BYTES: &str = "antnest.gateway.identity.resolve.cache.accounted_bytes";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_ENTRIES: &str = "antnest.gateway.identity.resolve.cache.entries";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_PROOF_AGE: &str = "antnest.gateway.identity.resolve.cache.proof.age";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_PROOF_AVAILABLE: &str = "antnest.gateway.identity.resolve.cache.proof.available";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_PROOF_FRESH: &str = "antnest.gateway.identity.resolve.cache.proof.fresh";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_WAITERS: &str = "antnest.gateway.identity.resolve.cache.waiters";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_CACHE_WORK: &str = "antnest.gateway.identity.resolve.cache.work";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_DECISIONS: &str = "antnest.gateway.identity.resolve.decisions";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_RPC_CALLS: &str = "antnest.gateway.identity.resolve.rpc.calls";
pub const ANTNEST_GATEWAY_IDENTITY_RESOLVE_RPC_DURATION: &str = "antnest.gateway.identity.resolve.rpc.duration";
pub const ANTNEST_HTTP_REQUEST_CANCELLED: &str = "antnest.http.request_cancelled";
pub const ANTNEST_HTTP_TERMINATION: &str = "antnest.http.termination";
pub const ANTNEST_HTTP_TRANSPORT_INVOKED: &str = "antnest.http.transport_invoked";
pub const ANTNEST_HTTP_UPGRADE_CONNECTION_SETUP_COMPLETED: &str = "antnest.http.upgrade.connection.setup.completed";
pub const ANTNEST_HTTP_UPGRADE_CONNECTION_SETUP_STARTED: &str = "antnest.http.upgrade.connection.setup.started";
pub const ANTNEST_HTTP_UPGRADE_RESPONSE_PREPARED: &str = "antnest.http.upgrade.response.prepared";
pub const ANTNEST_IDENTITY_AUTHENTICATION_METHOD: &str = "antnest.identity.authentication_method";
pub const ANTNEST_IDENTITY_HTTP_DURATION: &str = "antnest.identity.http.duration";
pub const ANTNEST_IDENTITY_HTTP_REQUESTS: &str = "antnest.identity.http.requests";
pub const ANTNEST_IDENTITY_PROVIDER_ID: &str = "antnest.identity.provider.id";
pub const ANTNEST_IDENTITY_PROVIDER_REVISION: &str = "antnest.identity.provider.revision";
pub const ANTNEST_IDENTITY_RESOLVE_CANCEL_KIND: &str = "antnest.identity.resolve.cancel_kind";
pub const ANTNEST_IDENTITY_RESOLVE_OUTCOME: &str = "antnest.identity.resolve.outcome";
pub const ANTNEST_IDENTITY_RESOLVE_PROFILE: &str = "antnest.identity.resolve.profile";
pub const ANTNEST_IDENTITY_RESOLVE_PROOF_AGE_MS: &str = "antnest.identity.resolve.proof_age_ms";
pub const ANTNEST_IDENTITY_RESOLVE_SHARED_SOURCE_STATE: &str = "antnest.identity.resolve.shared_source_state";
pub const ANTNEST_IDENTITY_RESOLVE_SNAPSHOT_AGE_MS: &str = "antnest.identity.resolve.snapshot_age_ms";
pub const ANTNEST_IDENTITY_RESOLVE_SOURCE: &str = "antnest.identity.resolve.source";
pub const ANTNEST_IDENTITY_RESOLVE_VALID_FOR_MS: &str = "antnest.identity.resolve.valid_for_ms";
pub const ANTNEST_IDENTITY_RESOURCE_ID: &str = "antnest.identity.resource.id";
pub const ANTNEST_IDENTITY_TOKEN_ID: &str = "antnest.identity.token.id";
pub const ANTNEST_LEARNING_APPLY_OUTCOME: &str = "antnest.learning.apply.outcome";
pub const ANTNEST_LEARNING_CALL_INDEX: &str = "antnest.learning.call_index";
pub const ANTNEST_LEARNING_CHANGE_ID: &str = "antnest.learning.change.id";
pub const ANTNEST_LEARNING_DEBUG: &str = "antnest.learning.debug";
pub const ANTNEST_LEARNING_EVIDENCE_CONTENT_BYTES: &str = "antnest.learning.evidence.content_bytes";
pub const ANTNEST_LEARNING_EVIDENCE_EXECUTION_ITEMS: &str = "antnest.learning.evidence.execution_items";
pub const ANTNEST_LEARNING_EVIDENCE_ITEMS: &str = "antnest.learning.evidence.items";
pub const ANTNEST_LEARNING_EVIDENCE_TRUNCATED: &str = "antnest.learning.evidence.truncated";
pub const ANTNEST_LEARNING_EVIDENCE_UNTRUSTED_ITEMS: &str = "antnest.learning.evidence.untrusted_items";
pub const ANTNEST_LEARNING_EVIDENCE_USER_ITEMS: &str = "antnest.learning.evidence.user_items";
pub const ANTNEST_LEARNING_GENERATION: &str = "antnest.learning.generation";
pub const ANTNEST_LEARNING_OUTCOME: &str = "antnest.learning.outcome";
pub const ANTNEST_LEARNING_PAUSE_REASON: &str = "antnest.learning.pause_reason";
pub const ANTNEST_LEARNING_REVIEW_DECISION: &str = "antnest.learning.review.decision";
pub const ANTNEST_LEARNING_REVIEW_PROMPT_VERSION: &str = "antnest.learning.review_prompt_version";
pub const ANTNEST_LEARNING_SOURCE_RUN_ID: &str = "antnest.learning.source_run.id";
pub const ANTNEST_LEARNING_TASK_ID: &str = "antnest.learning.task.id";
pub const ANTNEST_LEARNING_VALIDATION_CODES: &str = "antnest.learning.validation.codes";
pub const ANTNEST_LEARNING_VALIDATION_PATHS: &str = "antnest.learning.validation.paths";
pub const ANTNEST_LEARNING_VALIDATION_REASON: &str = "antnest.learning.validation.reason";
pub const ANTNEST_LEARNING_VALIDATION_RESULT: &str = "antnest.learning.validation.result";
pub const ANTNEST_LIFECYCLE_ERROR_CLASS_LEGACY: &str = "antnest.lifecycle.error_class";
pub const ANTNEST_LIFECYCLE_KIND: &str = "antnest.lifecycle.kind";
pub const ANTNEST_LIFECYCLE_PHASE: &str = "antnest.lifecycle.phase";
pub const ANTNEST_LIFECYCLE_STATE: &str = "antnest.lifecycle.state";
pub const ANTNEST_LISTENER: &str = "antnest.listener";
pub const ANTNEST_MANAGEMENT_NETWORK: &str = "antnest.management.network";
pub const ANTNEST_MCP_CALLER_CANCELLED: &str = "antnest.mcp.caller_cancelled";
pub const ANTNEST_MCP_CONNECTION_CLOSE_COMPLETED: &str = "antnest.mcp.connection.close.completed";
pub const ANTNEST_MCP_CONNECTION_CLOSE_OUTCOME: &str = "antnest.mcp.connection.close.outcome";
pub const ANTNEST_MCP_CONNECTION_CLOSE_STARTED: &str = "antnest.mcp.connection.close.started";
pub const ANTNEST_MCP_DISCOVERY_READY: &str = "antnest.mcp.discovery.ready";
pub const ANTNEST_MCP_METHOD: &str = "antnest.mcp.method";
pub const ANTNEST_MCP_RESOURCE_READ_STARTED: &str = "antnest.mcp.resource.read.started";
pub const ANTNEST_MCP_RESOURCE_VALIDATED: &str = "antnest.mcp.resource.validated";
pub const ANTNEST_MCP_RESOURCE_READ_OUTCOME: &str = "antnest.mcp.resource_read.outcome";
pub const ANTNEST_MCP_TOOL_DISPATCH_STARTED: &str = "antnest.mcp.tool.dispatch.started";
pub const ANTNEST_MCP_TOOL_RESULT_PARSED: &str = "antnest.mcp.tool.result.parsed";
pub const ANTNEST_MCP_TOOL_RESULT_OUTCOME: &str = "antnest.mcp.tool_result.outcome";
pub const ANTNEST_MEMBERSHIP_ID: &str = "antnest.membership.id";
pub const ANTNEST_MODEL_CONTENT_BYTES: &str = "antnest.model.content_bytes";
pub const ANTNEST_MODEL_MARKDOWN_FENCE: &str = "antnest.model.markdown_fence";
pub const ANTNEST_MODEL_MAX_OUTPUT_TOKENS: &str = "antnest.model.max_output_tokens";
pub const ANTNEST_MODEL_PROFILE_ID: &str = "antnest.model.profile_id";
pub const ANTNEST_MODEL_RESULT_KIND: &str = "antnest.model.result.kind";
pub const ANTNEST_MODEL_STOP_REASON: &str = "antnest.model.stop_reason";
pub const ANTNEST_MODEL_THOUGHT_BYTES: &str = "antnest.model.thought_bytes";
pub const ANTNEST_OBSERVATION_AFTER_GAP: &str = "antnest.observation.after_gap";
pub const ANTNEST_OBSERVATION_KIND: &str = "antnest.observation.kind";
pub const ANTNEST_OBSERVATION_SOURCE: &str = "antnest.observation.source";
pub const ANTNEST_OPERATION_ID: &str = "antnest.operation.id";
pub const ANTNEST_OPERATION_KIND: &str = "antnest.operation.kind";
pub const ANTNEST_OPERATION_PHASE: &str = "antnest.operation.phase";
pub const ANTNEST_OPERATION_REQUEST_ID_LEGACY: &str = "antnest.operation.request_id";
pub const ANTNEST_ORGANIZATION_ID: &str = "antnest.organization.id";
pub const ANTNEST_ORGANIZATION_ID_LEGACY: &str = "antnest.organization_id";
pub const ANTNEST_OUTCOME: &str = "antnest.outcome";
pub const ANTNEST_PASSWORD_ADMISSION_REASON: &str = "antnest.password.admission_reason";
pub const ANTNEST_PAYLOAD_JSON: &str = "antnest.payload.json";
pub const ANTNEST_PEER_SERVICE: &str = "antnest.peer.service";
pub const ANTNEST_PLATFORM: &str = "antnest.platform";
pub const ANTNEST_PLATFORM_OPERATION: &str = "antnest.platform.operation";
pub const ANTNEST_POLICY_ID: &str = "antnest.policy.id";
pub const ANTNEST_POLICY_REVISION: &str = "antnest.policy.revision";
pub const ANTNEST_PRINCIPAL_ID: &str = "antnest.principal.id";
pub const ANTNEST_PROTOCOL_NAME: &str = "antnest.protocol.name";
pub const ANTNEST_PROTOCOL_VERSION: &str = "antnest.protocol.version";
pub const ANTNEST_PROVIDER_CONNECTION_ID: &str = "antnest.provider.connection_id";
pub const ANTNEST_REQUEST: &str = "antnest.request";
pub const ANTNEST_REQUEST_DISPATCHED: &str = "antnest.request.dispatched";
pub const ANTNEST_REQUEST_ID: &str = "antnest.request.id";
pub const ANTNEST_REQUEST_SENT: &str = "antnest.request.sent";
pub const ANTNEST_REQUEST_TIMEOUT_MS: &str = "antnest.request.timeout_ms";
pub const ANTNEST_REQUEST_TRANSPORT_INVOKED: &str = "antnest.request.transport_invoked";
pub const ANTNEST_RESPONSE: &str = "antnest.response";
pub const ANTNEST_RESPONSE_TERMINATION: &str = "antnest.response.termination";
pub const ANTNEST_RESULT_LEGACY: &str = "antnest.result";
pub const ANTNEST_REVOCATION_REASON: &str = "antnest.revocation.reason";
pub const ANTNEST_REVOCATION_SEQUENCE: &str = "antnest.revocation.sequence";
pub const ANTNEST_REVOCATION_SPAN_ID: &str = "antnest.revocation.span_id";
pub const ANTNEST_REVOCATION_TRACE_ID: &str = "antnest.revocation.trace_id";
pub const ANTNEST_RUN_ID: &str = "antnest.run.id";
pub const ANTNEST_RUN_ID_LEGACY: &str = "antnest.run_id";
pub const ANTNEST_RUNTIME_EXECUTION_ID: &str = "antnest.runtime.execution.id";
pub const ANTNEST_RUNTIME_EXECUTION_ID_LEGACY: &str = "antnest.runtime.execution_id";
pub const ANTNEST_RUNTIME_EXECUTOR_CALLS: &str = "antnest.runtime.executor.calls";
pub const ANTNEST_RUNTIME_EXECUTOR_DURATION: &str = "antnest.runtime.executor.duration";
pub const ANTNEST_RUNTIME_GENERATION: &str = "antnest.runtime.generation";
pub const ANTNEST_RUNTIME_HEALTH: &str = "antnest.runtime.health";
pub const ANTNEST_RUNTIME_HTTP_DURATION: &str = "antnest.runtime.http.duration";
pub const ANTNEST_RUNTIME_HTTP_REQUESTS: &str = "antnest.runtime.http.requests";
pub const ANTNEST_RUNTIME_IMAGE_ID: &str = "antnest.runtime.image.id";
pub const ANTNEST_RUNTIME_IMAGE_REFERENCE: &str = "antnest.runtime.image.reference";
pub const ANTNEST_RUNTIME_MCP_DURATION: &str = "antnest.runtime.mcp.duration";
pub const ANTNEST_RUNTIME_MCP_OPERATIONS: &str = "antnest.runtime.mcp.operations";
pub const ANTNEST_RUNTIME_NETWORK_CONNECTION_REFUSED: &str = "antnest.runtime.network.connection_refused";
pub const ANTNEST_RUNTIME_NETWORK_INBOUND_BYTES: &str = "antnest.runtime.network.inbound.bytes";
pub const ANTNEST_RUNTIME_NETWORK_INBOUND_PACKETS: &str = "antnest.runtime.network.inbound.packets";
pub const ANTNEST_RUNTIME_NETWORK_LOCAL_REJECTIONS: &str = "antnest.runtime.network.local_rejections";
pub const ANTNEST_RUNTIME_NETWORK_MALFORMED_PACKETS: &str = "antnest.runtime.network.malformed.packets";
pub const ANTNEST_RUNTIME_NETWORK_OUTBOUND_BYTES: &str = "antnest.runtime.network.outbound.bytes";
pub const ANTNEST_RUNTIME_NETWORK_OUTBOUND_PACKETS: &str = "antnest.runtime.network.outbound.packets";
pub const ANTNEST_RUNTIME_NETWORK_UNSUPPORTED_PACKETS: &str = "antnest.runtime.network.unsupported.packets";
pub const ANTNEST_RUNTIME_PLATFORM_PHASE: &str = "antnest.runtime.platform_phase";
pub const ANTNEST_RUNTIME_PLATFORM_RESOURCE_ID: &str = "antnest.runtime.platform_resource_id";
pub const ANTNEST_RUNTIME_REVISION: &str = "antnest.runtime.revision";
pub const ANTNEST_RUNTIME_SPEC_DIGEST: &str = "antnest.runtime.spec_digest";
pub const ANTNEST_RUNTIME_TARGET_REVISION: &str = "antnest.runtime.target_revision";
pub const ANTNEST_RUNTIME_TOOL_CALLS: &str = "antnest.runtime.tool.calls";
pub const ANTNEST_RUNTIME_TOOL_DURATION: &str = "antnest.runtime.tool.duration";
pub const ANTNEST_RUNTIME_EXECUTION_ID_UNDERSCORE_LEGACY: &str = "antnest.runtime_execution_id";
pub const ANTNEST_SESSION_ID: &str = "antnest.session.id";
pub const ANTNEST_SETTLEMENT_OUTCOME: &str = "antnest.settlement.outcome";
pub const ANTNEST_SKILL_ACTIVE: &str = "antnest.skill.active";
pub const ANTNEST_SKILL_ARTIFACT_DIGEST: &str = "antnest.skill.artifact_digest";
pub const ANTNEST_SKILL_CONTENT_DIGEST: &str = "antnest.skill.content_digest";
pub const ANTNEST_SKILL_NAME: &str = "antnest.skill.name";
pub const ANTNEST_SKILL_SOURCE_SEQUENCE: &str = "antnest.skill.source_sequence";
pub const ANTNEST_STREAM_TERMINATION: &str = "antnest.stream.termination";
pub const ANTNEST_TARGET_SERVICE: &str = "antnest.target.service";
pub const ANTNEST_TEMPORAL_WORKFLOW_SPAN_END: &str = "antnest.temporal.workflow.span_end";
pub const ANTNEST_TIMEOUT_MS_LEGACY: &str = "antnest.timeout_ms";
pub const ANTNEST_TRANSACTION_COMPLETION: &str = "antnest.transaction.completion";
pub const ANTNEST_TRANSACTION_OUTCOME: &str = "antnest.transaction.outcome";
pub const ANTNEST_UI_ACP_CLOSE_DELETE_ATTEMPTS: &str = "antnest.ui.acp.close.delete_attempts";
pub const ANTNEST_UI_ACP_CLOSE_DELETE_COMPLETED: &str = "antnest.ui.acp.close.delete_completed";
pub const ANTNEST_UI_ACP_CLOSE_DELETE_RESPONSES: &str = "antnest.ui.acp.close.delete_responses";
pub const ANTNEST_UI_ACP_CLOSE_DELETE_STATUS: &str = "antnest.ui.acp.close.delete_status";
pub const ANTNEST_UI_ACP_CLOSE_DIAGNOSTICS_TRUNCATED: &str = "antnest.ui.acp.close.diagnostics_truncated";
pub const ANTNEST_UI_ACP_CLOSE_FAILURE: &str = "antnest.ui.acp.close.failure";
pub const ANTNEST_UI_ACP_CLOSE_FAILURES: &str = "antnest.ui.acp.close.failures";
pub const ANTNEST_UI_ACP_CLOSE_OUTCOME: &str = "antnest.ui.acp.close.outcome";
pub const ANTNEST_UI_ACP_CLOSE_PENDING_REQUESTS: &str = "antnest.ui.acp.close.pending_requests";
pub const ANTNEST_UI_ACP_CLOSE_STREAM_JOINED: &str = "antnest.ui.acp.close.stream_joined";
pub const ANTNEST_UI_ACP_CLOSE_TARGET_OBSERVED: &str = "antnest.ui.acp.close.target_observed";
pub const ANTNEST_UI_ACP_CLOSE_TRIGGER: &str = "antnest.ui.acp.close.trigger";
pub const ANTNEST_UI_AGENT_VIEW_FAILURE: &str = "antnest.ui.agent_view.failure";
pub const ANTNEST_UI_BRIDGE_ACTIVE_REPLAYS: &str = "antnest.ui.bridge.active_replays";
pub const ANTNEST_UI_BRIDGE_CACHED_HISTORY_BYTES: &str = "antnest.ui.bridge.cached_history_bytes";
pub const ANTNEST_UI_BRIDGE_COLD_REPLAY_DURATION: &str = "antnest.ui.bridge.cold_replay_duration";
pub const ANTNEST_UI_BRIDGE_HELD_WORK: &str = "antnest.ui.bridge.held_work";
pub const ANTNEST_UI_BRIDGE_JOURNAL_QUEUED_BYTES: &str = "antnest.ui.bridge.journal_queued_bytes";
pub const ANTNEST_UI_BRIDGE_JOURNAL_RETAINED_BYTES: &str = "antnest.ui.bridge.journal_retained_bytes";
pub const ANTNEST_UI_BRIDGE_LOCAL_INTENT_REUSE: &str = "antnest.ui.bridge.local_intent_reuse";
pub const ANTNEST_UI_BRIDGE_OBSERVER_LEASES: &str = "antnest.ui.bridge.observer_leases";
pub const ANTNEST_UI_BRIDGE_OLDEST_UNCERTAIN_MS: &str = "antnest.ui.bridge.oldest_uncertain_ms";
pub const ANTNEST_UI_BRIDGE_OWNERS: &str = "antnest.ui.bridge.owners";
pub const ANTNEST_UI_BRIDGE_QUEUED_REPLAYS: &str = "antnest.ui.bridge.queued_replays";
pub const ANTNEST_UI_BRIDGE_STREAM_SUBSCRIBERS: &str = "antnest.ui.bridge.stream_subscribers";
pub const ANTNEST_UI_BRIDGE_UNCERTAIN_OPERATIONS: &str = "antnest.ui.bridge.uncertain_operations";
pub const ANTNEST_UI_HTTP_DURATION: &str = "antnest.ui.http.duration";
pub const ANTNEST_UI_HTTP_REQUESTS: &str = "antnest.ui.http.requests";
pub const ANTNEST_UI_HTTP_STARTED_MONOTONIC_NS: &str = "antnest.ui.http.started_monotonic_ns";
pub const ANTNEST_UI_PROCESS_HEAP_USED_BYTES: &str = "antnest.ui.process.heap_used_bytes";
pub const ANTNEST_UI_PROCESS_RSS_BYTES: &str = "antnest.ui.process.rss_bytes";
pub const ANTNEST_UI_PROMPT_INPUT: &str = "antnest.ui.prompt_input";
pub const ANTNEST_UI_STREAM_DELEGATION_EXPIRES_AT_UNIX_MS: &str = "antnest.ui.stream.delegation_expires_at_unix_ms";
pub const ANTNEST_UI_STREAM_DELEGATION_REMAINING_MS: &str = "antnest.ui.stream.delegation_remaining_ms";
pub const ANTNEST_WATCH_TERMINATION: &str = "antnest.watch.termination";
pub const ANTNEST_EDGE_LOGIN_ADMISSION_TOTAL: &str = "antnest_edge_login_admission_total";

pub const DEPRECATED_ALIASES: &[(&str, &str)] = &[
    (ANTNEST_AGENT_ID_LEGACY, ANTNEST_AGENT_ID),
    (ANTNEST_ERROR_CLASS_LEGACY, ANTNEST_ERROR_CLASSIFICATION),
    (ANTNEST_LIFECYCLE_ERROR_CLASS_LEGACY, ANTNEST_ERROR_CLASSIFICATION),
    (ANTNEST_OPERATION_REQUEST_ID_LEGACY, ANTNEST_REQUEST_ID),
    (ANTNEST_ORGANIZATION_ID_LEGACY, ANTNEST_ORGANIZATION_ID),
    (ANTNEST_RESULT_LEGACY, ANTNEST_OUTCOME),
    (ANTNEST_RUN_ID_LEGACY, ANTNEST_RUN_ID),
    (ANTNEST_RUNTIME_EXECUTION_ID_LEGACY, ANTNEST_RUNTIME_EXECUTION_ID),
    (ANTNEST_RUNTIME_EXECUTION_ID_UNDERSCORE_LEGACY, ANTNEST_RUNTIME_EXECUTION_ID),
    (ANTNEST_TIMEOUT_MS_LEGACY, ANTNEST_REQUEST_TIMEOUT_MS),
];

pub const RESTRICTED_METRIC_ATTRIBUTES: &[&str] = &[
    ANTNEST_ACTOR_ID,
    ANTNEST_ADMISSION_ID,
    ANTNEST_AGENT_ID,
    ANTNEST_AGENT_REVISION,
    ANTNEST_AGENT_ID_LEGACY,
    ANTNEST_CONFIGURATION_APPLIED_REVISION,
    ANTNEST_CONFIGURATION_REVISION,
    ANTNEST_CONTEXT_MESSAGE_COUNT,
    ANTNEST_CONTEXT_TOOL_COUNT,
    ANTNEST_CONTROLLER_SCOPE,
    ANTNEST_DEADLINE,
    ANTNEST_ERROR_CAUSE_TYPES,
    ANTNEST_ERROR_CAUSES,
    ANTNEST_ERROR_MESSAGE,
    ANTNEST_ERROR_ORIGIN_SPAN_ID,
    ANTNEST_ERROR_ORIGIN_TRACE_ID,
    ANTNEST_EXECUTION_REVISION,
    ANTNEST_EXECUTION_TIMEOUT_MS,
    ANTNEST_IDENTITY_PROVIDER_ID,
    ANTNEST_IDENTITY_RESOURCE_ID,
    ANTNEST_IDENTITY_TOKEN_ID,
    ANTNEST_LEARNING_CALL_INDEX,
    ANTNEST_LEARNING_CHANGE_ID,
    ANTNEST_LEARNING_EVIDENCE_CONTENT_BYTES,
    ANTNEST_LEARNING_EVIDENCE_EXECUTION_ITEMS,
    ANTNEST_LEARNING_EVIDENCE_ITEMS,
    ANTNEST_LEARNING_EVIDENCE_UNTRUSTED_ITEMS,
    ANTNEST_LEARNING_EVIDENCE_USER_ITEMS,
    ANTNEST_LEARNING_GENERATION,
    ANTNEST_LEARNING_REVIEW_PROMPT_VERSION,
    ANTNEST_LEARNING_SOURCE_RUN_ID,
    ANTNEST_LEARNING_TASK_ID,
    ANTNEST_LEARNING_VALIDATION_CODES,
    ANTNEST_LEARNING_VALIDATION_PATHS,
    ANTNEST_MANAGEMENT_NETWORK,
    ANTNEST_MEMBERSHIP_ID,
    ANTNEST_MODEL_CONTENT_BYTES,
    ANTNEST_MODEL_MAX_OUTPUT_TOKENS,
    ANTNEST_MODEL_PROFILE_ID,
    ANTNEST_MODEL_THOUGHT_BYTES,
    ANTNEST_OPERATION_ID,
    ANTNEST_OPERATION_REQUEST_ID_LEGACY,
    ANTNEST_ORGANIZATION_ID,
    ANTNEST_ORGANIZATION_ID_LEGACY,
    ANTNEST_PAYLOAD_JSON,
    ANTNEST_POLICY_ID,
    ANTNEST_PRINCIPAL_ID,
    ANTNEST_PROVIDER_CONNECTION_ID,
    ANTNEST_REQUEST_ID,
    ANTNEST_REQUEST_TIMEOUT_MS,
    ANTNEST_REVOCATION_SEQUENCE,
    ANTNEST_REVOCATION_SPAN_ID,
    ANTNEST_REVOCATION_TRACE_ID,
    ANTNEST_RUN_ID,
    ANTNEST_RUN_ID_LEGACY,
    ANTNEST_RUNTIME_EXECUTION_ID,
    ANTNEST_RUNTIME_EXECUTION_ID_LEGACY,
    ANTNEST_RUNTIME_GENERATION,
    ANTNEST_RUNTIME_IMAGE_ID,
    ANTNEST_RUNTIME_IMAGE_REFERENCE,
    ANTNEST_RUNTIME_PLATFORM_RESOURCE_ID,
    ANTNEST_RUNTIME_REVISION,
    ANTNEST_RUNTIME_SPEC_DIGEST,
    ANTNEST_RUNTIME_TARGET_REVISION,
    ANTNEST_RUNTIME_EXECUTION_ID_UNDERSCORE_LEGACY,
    ANTNEST_SESSION_ID,
    ANTNEST_SKILL_ARTIFACT_DIGEST,
    ANTNEST_SKILL_CONTENT_DIGEST,
    ANTNEST_SKILL_NAME,
    ANTNEST_SKILL_SOURCE_SEQUENCE,
    ANTNEST_TIMEOUT_MS_LEGACY,
    ANTNEST_UI_ACP_CLOSE_DELETE_ATTEMPTS,
    ANTNEST_UI_ACP_CLOSE_DELETE_RESPONSES,
    ANTNEST_UI_ACP_CLOSE_DELETE_STATUS,
    ANTNEST_UI_ACP_CLOSE_FAILURES,
    ANTNEST_UI_ACP_CLOSE_PENDING_REQUESTS,
    ANTNEST_UI_HTTP_STARTED_MONOTONIC_NS,
    ANTNEST_UI_STREAM_DELEGATION_EXPIRES_AT_UNIX_MS,
    ANTNEST_UI_STREAM_DELEGATION_REMAINING_MS,
];
