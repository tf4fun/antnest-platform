package application

import (
	"context"
	"errors"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type ExecutionPublicationOption func(*ExecutionPublisher)

func WithRuntimeConnectionResolver(resolver ports.RuntimeConnectionResolver) ExecutionPublicationOption {
	return func(publisher *ExecutionPublisher) { publisher.runtime = resolver }
}

func (publisher *ExecutionPublisher) resolveRuntimeAuthority(ctx context.Context, snapshot *ports.ExecutionSnapshot) error {
	for index := range snapshot.Agents {
		agent := &snapshot.Agents[index]
		// Closure must remain possible while compute is missing/unhealthy.
		// Its retained binding is only a fence for already accepted operations.
		if !agent.AcceptingRuns {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if publisher.runtime == nil || agent.Runtime == nil {
			return &ports.DependencyError{Service: "runtime-controller", Code: "runtime_connection_unavailable", Retryable: true}
		}
		connection, err := publisher.runtime.ResolveRuntimeConnection(ctx, agent.AgentID, agent.Runtime.RuntimeRevision, agent.Runtime.RuntimeExecutionID)
		if err != nil {
			return runtimeResolutionFailure(err)
		}
		if !connection.Matches(agent.AgentID, *agent.Runtime) {
			return &ports.DependencyError{Service: "runtime-controller", Code: "invalid_response", Retryable: true}
		}
		agent.Runtime.ConnectionID = connection.ConnectionID
		credential := connection.Credential
		agent.Runtime.Credential = &credential
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return snapshot.ValidateForPublication()
}

func runtimeResolutionFailure(err error) error {
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded} {
		if errors.Is(err, sentinel) {
			return sentinel
		}
	}
	var dependency *ports.DependencyError
	if errors.As(err, &dependency) && dependency.Service == "runtime-controller" {
		for _, code := range []string{"invalid_request", "invalid_response", "runtime_not_found", "runtime_connection_stale",
			"runtime_connection_unavailable", "service_unauthenticated", "caller_not_allowed", "control_plane_unavailable"} {
			if dependency.Code == code {
				return &ports.DependencyError{Service: "runtime-controller", Code: code, Retryable: dependency.Retryable}
			}
		}
	}
	return &ports.DependencyError{Service: "runtime-controller", Code: "runtime_connection_unavailable", Retryable: true}
}
