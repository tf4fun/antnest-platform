package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

type NetworkPolicyService interface {
	GetAgentNetworkPolicy(context.Context, string, string) (application.AgentNetworkPolicyView, error)
	SetAgentNetworkPolicy(context.Context, application.SetAgentNetworkPolicyInput) (ports.NetworkPolicyAssignment, error)
}

func (h *handler) getAgentNetworkPolicy(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	org, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	result, err := h.network.GetAgentNetworkPolicy(request.Context(), org, request.PathValue("agent_id"))
	if err != nil {
		writeNetworkPolicyError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *handler) setAgentNetworkPolicy(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if _, ok := strictQuery(response, request, map[string]struct{}{}); !ok {
		return
	}
	var input application.SetAgentNetworkPolicyInput
	if !decodeJSON(response, request, &input) {
		return
	}
	input.AgentID = request.PathValue("agent_id")
	result, err := h.network.SetAgentNetworkPolicy(request.Context(), input)
	observeNetworkPolicyResult(request.Context(), input, err)
	if err != nil {
		writeNetworkPolicyError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func writeNetworkPolicyError(ctx context.Context, response http.ResponseWriter, err error) {
	status, payload := publicNetworkPolicyError(err)
	telemetry.RecordBoundaryError(ctx, err, "network_policy", payload.Code, payload.Message, status >= 500)
	trace.SpanFromContext(ctx).SetStatus(codes.Error, payload.Code)
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("error.type", payload.Code))
	writeJSON(response, status, payload)
}

func publicNetworkPolicyError(err error) (int, errorResponse) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return http.StatusServiceUnavailable, errorResponse{Code: "dependency_unavailable", Message: "Network policy outcome is unknown; retry the original versioned request", Retryable: true}
	}
	var failure *ports.DependencyError
	if !errors.As(err, &failure) || failure.Service != "runtime-egress" {
		return publicError(err)
	}
	switch failure.Code {
	case "invalid_request":
		return http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "Network policy request is invalid"}
	case "resource_version_conflict":
		return http.StatusConflict, errorResponse{Code: failure.Code, Message: "Network policy changed; reload before choosing a new update"}
	case "policy_revision_not_found":
		return http.StatusNotFound, errorResponse{Code: failure.Code, Message: "Network policy revision was not found"}
	case "agent_network_not_found":
		return http.StatusNotFound, errorResponse{Code: failure.Code, Message: "Agent network has not been allocated"}
	case "agent_network_unavailable":
		return http.StatusConflict, errorResponse{Code: failure.Code, Message: "Agent network is unavailable"}
	case "cleanup_failed":
		return http.StatusServiceUnavailable, errorResponse{Code: failure.Code, Message: "Network cleanup did not complete; traffic remains fenced", Retryable: true}
	case "invalid_response":
		return http.StatusBadGateway, errorResponse{Code: "dependency_invalid_response", Message: "Network policy outcome could not be confirmed", Retryable: true}
	default:
		return http.StatusServiceUnavailable, errorResponse{Code: "dependency_unavailable", Message: "Network policy outcome is unknown; retry the original versioned request", Retryable: true}
	}
}

func observeNetworkPolicyResult(ctx context.Context, input application.SetAgentNetworkPolicyInput, err error) {
	result := "success"
	errorCode := ""
	if err != nil {
		result = "error"
		_, payload := publicNetworkPolicyError(err)
		errorCode = payload.Code
	}
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(attribute.String("antnest.result", result))
	if errors.Is(err, application.ErrInvalidInput) {
		return
	}
	span.SetAttributes(attribute.String("antnest.request.id", input.RequestID), attribute.String("antnest.organization.id", input.OrganizationID),
		attribute.String("antnest.agent.id", input.AgentID), attribute.String("antnest.actor.id", input.ActorPrincipalID),
		attribute.String("antnest.policy.id", input.PolicyID))
	slog.InfoContext(ctx, "Agent network policy command completed", "request_id", input.RequestID, "organization_id", input.OrganizationID,
		"agent_id", input.AgentID, "actor_principal_id", input.ActorPrincipalID, "policy_id", input.PolicyID, "policy_revision", input.Revision,
		"expected_resource_version", input.ExpectedResourceVersion, "result", result, "error_class", errorCode)
}
