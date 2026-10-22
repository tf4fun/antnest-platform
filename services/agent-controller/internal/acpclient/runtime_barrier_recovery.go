package acpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"go.opentelemetry.io/otel/attribute"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

var _ ports.RuntimeBarrierReader = (*Client)(nil)

func (client *Client) GetRuntimeBarrier(ctx context.Context, query ports.RuntimeBarrierQuery) (result ports.RuntimeBarrierResult, resultErr error) {
	if err := query.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, call := telemetry.StartHTTPCall(ctx, "get_runtime_barrier", []attribute.KeyValue{
		attribute.String("antnest.organization.id", query.OrganizationID), attribute.String("antnest.agent.id", query.AgentID),
	})
	defer func() { call.Finish(resultErr) }()
	var wire runtimeBarrierResultWire
	if err := client.exchange(ctx, "get-runtime-barrier", query, &wire); err != nil {
		return ports.RuntimeBarrierResult{}, err
	}
	// exchange joins the actual body Close. Cancellation during that cleanup
	// must still prevent a successful recovery fact from escaping afterwards.
	if err := ctx.Err(); err != nil {
		return ports.RuntimeBarrierResult{}, failure("dependency_unavailable", true, err)
	}
	if !wire.result.Matches(query) {
		return ports.RuntimeBarrierResult{}, failure("invalid_response", true, nil)
	}
	return wire.result, nil
}

// Only this method uses the stricter wire decoder. In particular, missing
// barrier is invalid; only an explicit JSON null denotes absence of a fact.
type runtimeBarrierResultWire struct {
	result ports.RuntimeBarrierResult
}

func (wire *runtimeBarrierResultWire) UnmarshalJSON(raw []byte) error {
	if !runtimeBarrierJSONUnicode(raw) {
		return errors.New("invalid runtime barrier Unicode escape")
	}
	var document struct {
		OrganizationID  string          `json:"organization_id"`
		AgentID         string          `json:"agent_id"`
		RuntimeRevision string          `json:"runtime_revision"`
		Barrier         json.RawMessage `json:"barrier"`
	}
	if err := serviceauth.DecodeObject(raw, &document); err != nil {
		return err
	}
	if len(document.Barrier) == 0 {
		return errors.New("runtime barrier field required")
	}
	result := ports.RuntimeBarrierResult{OrganizationID: document.OrganizationID,
		AgentID: document.AgentID, RuntimeRevision: document.RuntimeRevision}
	if !bytes.Equal(bytes.TrimSpace(document.Barrier), []byte("null")) {
		var barrier ports.RuntimeBarrier
		if err := serviceauth.DecodeObject(document.Barrier, &barrier); err != nil {
			return err
		}
		result.Barrier = &barrier
	}
	wire.result = result
	return nil
}

// encoding/json replaces unpaired surrogate escapes with U+FFFD. Reject that
// lossy conversion before decoding opaque identities. JSON syntax is checked
// by the outer decoder; escaped backslashes are skipped, never decoded twice.
func runtimeBarrierJSONUnicode(raw []byte) bool {
	for index := 0; index < len(raw); index++ {
		if raw[index] != '\\' {
			continue
		}
		index++
		if index >= len(raw) {
			return false
		}
		if raw[index] != 'u' {
			continue
		}
		if index+4 >= len(raw) {
			return false
		}
		unit, err := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		if err != nil || (unit >= 0xdc00 && unit <= 0xdfff) {
			return false
		}
		index += 4
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(raw[index+3:index+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		index += 6
	}
	return true
}
