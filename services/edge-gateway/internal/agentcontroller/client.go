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
)

const (
	maximumResponseBytes  = 2 << 20
	workspacePageLimit    = 200
	maximumWorkspacePages = 100
)

type WorkspaceAgent struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
}

type ListWorkspaceAgentsInput struct {
	RequestID      string
	OrganizationID string
	PrincipalID    string
}

type Service interface {
	ListWorkspaceAgents(context.Context, ListWorkspaceAgentsInput) ([]WorkspaceAgent, error)
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
			ctx, http.MethodPost,
			"/rpc/agent-controller/list-workspace-agents", request, &result,
		); err != nil {
			return nil, err
		}
		if result.Agents == nil {
			return nil, fmt.Errorf("agent controller returned a missing workspace list")
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

func (client *Client) doJSON(
	ctx context.Context, method string, path string, input any, output any,
) error {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
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
	response, err := client.httpClient.Do(request)
	if err != nil {
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
		return fmt.Errorf("agent controller request failed with status %d", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode Agent Controller response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("decode Agent Controller response: trailing data")
	}
	return nil
}

func validWorkspaceAgent(agent WorkspaceAgent) bool {
	return strings.TrimSpace(agent.AgentID) != "" && strings.TrimSpace(agent.Name) != ""
}

var _ Service = (*Client)(nil)
