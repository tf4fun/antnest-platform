package ports

import (
	"context"
	"errors"
	"unicode/utf8"
)

var ErrInvalidRuntimeBarrierQuery = errors.New("invalid Runtime barrier query")

type RuntimeBarrierQuery struct {
	OrganizationID          string `json:"organization_id"`
	AgentID                 string `json:"agent_id"`
	ExpectedRuntimeRevision string `json:"expected_runtime_revision"`
}

type RuntimeBarrier struct {
	BarrierID          string `json:"barrier_id"`
	Reason             string `json:"reason"`
	RuntimeExecutionID string `json:"runtime_execution_id"`
}

// RuntimeBarrierResult is a scoped recovery fact, not execution readiness or
// settlement. A nil Barrier means only that ACP has no matching recovery fact.
type RuntimeBarrierResult struct {
	OrganizationID  string          `json:"organization_id"`
	AgentID         string          `json:"agent_id"`
	RuntimeRevision string          `json:"runtime_revision"`
	Barrier         *RuntimeBarrier `json:"barrier"`
}

// RuntimeBarrierReader is separate from execution publication and settlement.
type RuntimeBarrierReader interface {
	GetRuntimeBarrier(context.Context, RuntimeBarrierQuery) (RuntimeBarrierResult, error)
}

func (query RuntimeBarrierQuery) Validate() error {
	if !runtimeBarrierIdentity(query.OrganizationID) || !runtimeBarrierIdentity(query.AgentID) ||
		!runtimeBarrierIdentity(query.ExpectedRuntimeRevision) {
		return ErrInvalidRuntimeBarrierQuery
	}
	return nil
}

// Matches validates the complete fact against the original requested scope.
// The retained execution identity belongs to the barrier, not a newer Runtime
// health observation, and must be preserved without normalization.
func (result RuntimeBarrierResult) Matches(query RuntimeBarrierQuery) bool {
	if query.Validate() != nil || result.OrganizationID != query.OrganizationID ||
		result.AgentID != query.AgentID || result.RuntimeRevision != query.ExpectedRuntimeRevision {
		return false
	}
	return result.Barrier == nil ||
		(runtimeBarrierIdentity(result.Barrier.BarrierID) &&
			result.Barrier.Reason == ExecutionRuntimeBarrierRequired &&
			runtimeBarrierIdentity(result.Barrier.RuntimeExecutionID))
}

func runtimeBarrierIdentity(value string) bool {
	if !utf8.ValidString(value) {
		return false
	}
	length := utf8.RuneCountInString(value)
	if length < 1 || length > 200 {
		return false
	}
	// The frozen ACP contract uses ECMAScript \S with Unicode codepoint length.
	// unicode.IsSpace also rejects NEL and omits BOM, so it is not equivalent.
	for _, character := range value {
		switch {
		case character >= '\u0009' && character <= '\u000d',
			character >= '\u2000' && character <= '\u200a':
			return false
		case character == '\u0020', character == '\u00a0', character == '\u1680',
			character == '\u2028', character == '\u2029', character == '\u202f',
			character == '\u205f', character == '\u3000', character == '\ufeff':
			return false
		}
	}
	return true
}
