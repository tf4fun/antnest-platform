package acpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"go.opentelemetry.io/otel/attribute"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

var _ ports.ExecutionV2Client = (*Client)(nil)

var executionDigestRequiredKeys = []string{
	"organization_id", "schema_version", "revision", "digest",
	"providers", "models", "agents", "organization_budget_digest",
}

type executionDigestRequest struct {
	OrganizationID string `json:"organization_id"`
}

type executionDigestWire struct{ digest ports.ExecutionDigest }

func (wire *executionDigestWire) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	if len(fields) != len(executionDigestRequiredKeys) {
		return errors.New("execution digest field count mismatch")
	}
	for _, key := range executionDigestRequiredKeys {
		value, present := fields[key]
		if !present {
			return fmt.Errorf("execution digest misses %s", key)
		}
		if key != "digest" && key != "organization_budget_digest" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("execution digest %s is null", key)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(&wire.digest)
}

func (client *Client) GetExecutionDigest(ctx context.Context, organizationID string) (result ports.ExecutionDigest, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, call := telemetry.StartHTTPCall(ctx, "get_execution_digest", []attribute.KeyValue{
		attribute.String("antnest.organization.id", organizationID),
	})
	defer func() { call.Finish(resultErr) }()
	var wire executionDigestWire
	if err := client.exchange(ctx, "get-execution-digest", executionDigestRequest{OrganizationID: organizationID}, &wire); err != nil {
		return ports.ExecutionDigest{}, err
	}
	result = wire.digest
	if result.OrganizationID != organizationID || result.Validate() != nil {
		return ports.ExecutionDigest{}, failure("invalid_response", true, nil)
	}
	call.SetAttributes(attribute.Int64("antnest.configuration.revision", result.Revision))
	return result, nil
}

func (client *Client) ApplyExecutionDelta(ctx context.Context, delta ports.ExecutionDelta) (result ports.ExecutionAcknowledgement, resultErr error) {
	if err := delta.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, call := telemetry.StartHTTPCall(ctx, "apply_execution_delta", []attribute.KeyValue{
		attribute.String("antnest.organization.id", delta.OrganizationID), attribute.Int64("antnest.configuration.revision", delta.Revision),
	})
	defer func() { call.Finish(resultErr) }()
	if err := client.exchange(ctx, "apply-execution-delta", delta, &result); err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if result.OrganizationID != delta.OrganizationID || !appliedRevision(result.AppliedRevision, delta.Revision) {
		return ports.ExecutionAcknowledgement{}, failure("invalid_response", true, nil)
	}
	call.SetAttributes(attribute.Int64("antnest.configuration.applied_revision", result.AppliedRevision))
	return result, nil
}
