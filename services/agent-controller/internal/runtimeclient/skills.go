package runtimeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"

	"go.opentelemetry.io/otel/attribute"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

var preparedReferencePattern = regexp.MustCompile(`^psr_[0-9a-f]{32}$`)
var skillSetDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func (client *Client) PrepareSkillSet(ctx context.Context, requestID, agentID string, input ports.SkillPreparationRequest) (ports.SkillPreparationReceipt, error) {
	computed, err := domain.SkillSetDigest(input.OrganizationID, input.SystemSkills)
	if err != nil || input.OwnerOperationID == "" || input.LayoutVersion != domain.SkillLayoutVersion || input.SystemSkills == nil || computed != input.SkillSetDigest {
		return ports.SkillPreparationReceipt{}, dependencyFailure("invalid_request", false, err)
	}
	path := "/internal/runtimes/" + url.PathEscape(agentID) + "/skill-sets/prepare"
	body, err := client.skillRequest(ctx, http.MethodPost, path, "", requestID, input, http.StatusAccepted, "prepare_skills", agentID)
	if err != nil {
		return ports.SkillPreparationReceipt{}, err
	}
	receipt, err := decodeSkillPreparation(body, requestID, agentID, input.OrganizationID, input.OwnerOperationID)
	if err != nil {
		return ports.SkillPreparationReceipt{}, err
	}
	if receipt.State == "ready" && (receipt.PreparedSkillSet.SkillSetDigest != input.SkillSetDigest || receipt.PreparedSkillSet.LayoutVersion != input.LayoutVersion) {
		return ports.SkillPreparationReceipt{}, dependencyFailure("invalid_response", true)
	}
	return receipt, nil
}

func (client *Client) GetSkillPreparation(ctx context.Context, organizationID, agentID, requestID string) (ports.SkillPreparationReceipt, error) {
	path := "/internal/runtimes/" + url.PathEscape(agentID) + "/skill-sets/preparations/" + url.PathEscape(requestID)
	query := url.Values{"organization_id": {organizationID}}.Encode()
	body, err := client.skillRequest(ctx, http.MethodGet, path, query, "", nil, http.StatusOK, "get_skill_preparation", agentID)
	if err != nil {
		return ports.SkillPreparationReceipt{}, err
	}
	return decodeSkillPreparation(body, requestID, agentID, organizationID, "")
}

func (client *Client) ReleaseSkillPreparation(ctx context.Context, releaseID, organizationID, agentID, requestID, ownerOperationID string) error {
	path := "/internal/runtimes/" + url.PathEscape(agentID) + "/skill-sets/preparations/" + url.PathEscape(requestID) + "/release"
	input := struct {
		OrganizationID   string `json:"organization_id"`
		OwnerOperationID string `json:"owner_operation_id"`
	}{organizationID, ownerOperationID}
	body, err := client.skillRequest(ctx, http.MethodPost, path, "", releaseID, input, http.StatusNoContent, "release_skill_preparation", agentID)
	if err != nil {
		return err
	}
	if len(body) != 0 {
		return dependencyFailure("invalid_response", true)
	}
	return nil
}

func (client *Client) skillRequest(ctx context.Context, method, path, query, requestID string, payload any, wantStatus int, action, agentID string) (body []byte, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, action, []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()
	var input io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, dependencyFailure("invalid_request", false, err)
		}
		input = bytes.NewReader(encoded)
	}
	endpoint := *client.baseURL
	endpoint.Path = path
	endpoint.RawQuery = query
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), input)
	if err != nil {
		return nil, dependencyFailure("invalid_request", false, err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if requestID != "" {
		request.Header.Set("Idempotency-Key", requestID)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return nil, dependencyFailure("invalid_response", true, readErr, closeErr)
	}
	if response.StatusCode != wantStatus {
		return nil, decodeFailure(responseBody, response.StatusCode)
	}
	return responseBody, nil
}

func decodeSkillPreparation(body []byte, requestID, agentID, organizationID, ownerOperationID string) (ports.SkillPreparationReceipt, error) {
	var receipt ports.SkillPreparationReceipt
	if err := json.Unmarshal(body, &receipt); err != nil {
		return ports.SkillPreparationReceipt{}, dependencyFailure("invalid_response", true, err)
	}
	if receipt.RequestID != requestID || receipt.AgentID != agentID || receipt.OrganizationID != organizationID || receipt.OwnerOperationID == "" || ownerOperationID != "" && receipt.OwnerOperationID != ownerOperationID ||
		!oneOf(receipt.State, "queued", "preparing", "retry_wait", "paused", "ready", "rejected", "invalidated", "cleanup_pending") ||
		receipt.Progress.VerifiedPackages < 0 || receipt.Progress.TotalPackages < 0 || receipt.Progress.VerifiedPackages > receipt.Progress.TotalPackages ||
		receipt.Progress.VerifiedBytes < 0 || receipt.Progress.TotalBytes < 0 || receipt.Progress.VerifiedBytes > receipt.Progress.TotalBytes {
		return ports.SkillPreparationReceipt{}, dependencyFailure("invalid_response", true, fmt.Errorf("skill preparation receipt identity or progress differs"))
	}
	if receipt.State == "ready" {
		if receipt.PreparedSkillSet == nil || receipt.PreparedSkillSet.LayoutVersion != 1 || !skillSetDigestPattern.MatchString(receipt.PreparedSkillSet.SkillSetDigest) || !preparedReferencePattern.MatchString(receipt.PreparedReferenceID) {
			return ports.SkillPreparationReceipt{}, dependencyFailure("invalid_response", true)
		}
	} else if receipt.PreparedSkillSet != nil || receipt.PreparedReferenceID != "" {
		return ports.SkillPreparationReceipt{}, dependencyFailure("invalid_response", true)
	}
	return receipt, nil
}

var _ ports.SkillPreparationClient = (*Client)(nil)
