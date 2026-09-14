package acpclient

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"

	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
	timeout    time.Duration
}

var _ ports.ExecutionClient = (*Client)(nil)

func New(baseURL string, timeout time.Duration, httpClient *http.Client) (*Client, error) {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(endpoint.Path != "" && endpoint.Path != "/") {
		return nil, fmt.Errorf("ACP service URL must be an HTTP origin")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("ACP service timeout must be positive")
	}
	client := telemetry.HTTPClient(httpClient, "agent-acp-service")
	// Execution snapshots contain current credentials and cannot follow redirects.
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{baseURL: endpoint, httpClient: client, timeout: timeout}, nil
}

func (client *Client) ApplyExecutionSnapshot(ctx context.Context, snapshot ports.ExecutionSnapshot) (result ports.ExecutionAcknowledgement, resultErr error) {
	if err := snapshot.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, call := telemetry.StartHTTPCall(ctx, "apply_execution_snapshot", []attribute.KeyValue{
		attribute.String("antnest.organization.id", snapshot.OrganizationID), attribute.Int64("antnest.configuration.revision", snapshot.Revision),
	})
	defer func() { call.Finish(resultErr) }()
	if err := client.exchange(ctx, "apply-execution-snapshot", snapshot, &result); err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if result.OrganizationID != snapshot.OrganizationID || !appliedRevision(result.AppliedRevision, snapshot.Revision) {
		return ports.ExecutionAcknowledgement{}, failure("invalid_response", true, nil)
	}
	call.SetAttributes(attribute.Int64("antnest.configuration.applied_revision", result.AppliedRevision))
	return result, nil
}

func (client *Client) SettleAgent(ctx context.Context, request ports.AgentSettlementRequest) (result ports.AgentSettlementResult, resultErr error) {
	if err := request.Validate(); err != nil {
		return result, err
	}
	request.DeadlineAt = request.DeadlineAt.UTC()
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, call := telemetry.StartHTTPCall(ctx, "settle_agent", []attribute.KeyValue{
		attribute.String("antnest.organization.id", request.OrganizationID), attribute.String("antnest.agent.id", request.AgentID),
		attribute.String("antnest.operation.id", request.OperationID), attribute.Int64("antnest.configuration.revision", request.MinimumRevision),
	})
	defer func() { call.Finish(resultErr) }()
	if err := client.exchange(ctx, "settle-agent", request, &result); err != nil {
		return ports.AgentSettlementResult{}, err
	}
	if !appliedRevision(result.AppliedRevision, request.MinimumRevision) || !settlementOutcome(result.Outcome) {
		return ports.AgentSettlementResult{}, failure("invalid_response", true, nil)
	}
	call.SetAttributes(attribute.Int64("antnest.configuration.applied_revision", result.AppliedRevision), attribute.String("antnest.settlement.outcome", result.Outcome))
	return result, nil
}

func appliedRevision(actual, minimum int64) bool {
	return actual >= minimum && actual <= ports.MaximumExecutionRevision
}

func settlementOutcome(outcome string) bool {
	return outcome == ports.ExecutionSettled || outcome == ports.ExecutionNotSettled || outcome == ports.ExecutionRuntimeBarrierRequired
}
