package agentcontroller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("soft/antnest-platform/edge-gateway/agent-controller-client")

const (
	maximumResponseBytes  = 2 << 20
	workspacePageLimit    = 200
	maximumWorkspacePages = 100
)

type WorkspaceAgent struct {
	AgentID            string `json:"agent_id"`
	Name               string `json:"name"`
	Availability       string `json:"availability"`
	AgentAccessSubject string `json:"agent_access_subject"`
}

type ListWorkspaceAgentsInput struct {
	RequestID      string
	OrganizationID string
	PrincipalID    string
}

type Service interface {
	ListWorkspaceAgents(context.Context, ListWorkspaceAgentsInput) ([]WorkspaceAgent, error)
	Ready(context.Context) error
}

type Client struct {
	base       *url.URL
	httpClient *http.Client
}

func NewClient(rawBaseURL string, httpClient *http.Client) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(rawBaseURL))
	if err != nil || base.Scheme == "" || base.Host == "" || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("agent controller URL is invalid")
	}
	if httpClient == nil {
		return nil, fmt.Errorf("agent controller HTTP client is required")
	}
	return &Client{base: base, httpClient: httpClient}, nil
}

func (client *Client) ListWorkspaceAgents(
	ctx context.Context, input ListWorkspaceAgentsInput,
) ([]WorkspaceAgent, error) {
	agents := make([]WorkspaceAgent, 0)
	cursor := ""
	seenCursors := make(map[string]struct{})
	for page := 0; page < maximumWorkspacePages; page++ {
		var result struct {
			Agents     []WorkspaceAgent `json:"agents"`
			NextCursor *string          `json:"next_cursor"`
		}
		request := map[string]any{
			"request_id":      fmt.Sprintf("%s-page-%d", input.RequestID, page+1),
			"organization_id": input.OrganizationID, "principal_id": input.PrincipalID,
			"limit": workspacePageLimit,
		}
		if cursor != "" {
			request["cursor"] = cursor
		}
		if err := client.doJSON(
			ctx, "list_workspace_agents", http.MethodPost,
			"/rpc/agent-controller/list-workspace-agents", request, &result,
		); err != nil {
			return nil, err
		}
		for _, agent := range result.Agents {
			if !validWorkspaceAgent(agent) {
				return nil, fmt.Errorf("agent controller returned an invalid workspace Agent")
			}
			agents = append(agents, agent)
		}
		if result.NextCursor == nil {
			return agents, nil
		}
		cursor = strings.TrimSpace(*result.NextCursor)
		if cursor == "" {
			return nil, fmt.Errorf("agent controller returned an empty workspace cursor")
		}
		if _, exists := seenCursors[cursor]; exists {
			return nil, fmt.Errorf("agent controller repeated a workspace cursor")
		}
		seenCursors[cursor] = struct{}{}
	}
	return nil, fmt.Errorf("agent controller workspace pagination exceeded its bound")
}

func (client *Client) Ready(ctx context.Context) error {
	return client.doJSON(ctx, "status", http.MethodGet, "/status", nil, nil)
}

func (client *Client) doJSON(
	ctx context.Context, operation string, method string, path string, input any, output any,
) error {
	ctx, span := tracer.Start(ctx, "agent_controller."+operation, trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	span.SetAttributes(attribute.String("rpc.system", "http"), attribute.String("rpc.method", operation))

	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "encode request")
			return fmt.Errorf("encode Agent Controller request: %w", err)
		}
		body = bytes.NewReader(payload)
	}
	target := client.base.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return fmt.Errorf("create Agent Controller request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "transport failure")
		return fmt.Errorf("agent controller unavailable: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read Agent Controller response: %w", err)
	}
	if len(payload) > maximumResponseBytes {
		return fmt.Errorf("agent controller response exceeds limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		span.SetStatus(codes.Error, fmt.Sprintf("status %d", response.StatusCode))
		return fmt.Errorf("agent controller request failed with status %d", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid response")
		return fmt.Errorf("decode Agent Controller response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("decode Agent Controller response: trailing data")
	}
	return nil
}

func validWorkspaceAgent(agent WorkspaceAgent) bool {
	if strings.TrimSpace(agent.AgentID) == "" || strings.TrimSpace(agent.Name) == "" ||
		strings.TrimSpace(agent.AgentAccessSubject) == "" {
		return false
	}
	switch agent.Availability {
	case "ready", "busy", "offline":
		return true
	default:
		return false
	}
}

var _ Service = (*Client)(nil)
