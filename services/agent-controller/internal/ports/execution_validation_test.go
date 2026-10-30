package ports

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestExecutionModelProfileRevisionValidation(t *testing.T) {
	valid := ExecutionModel{
		ModelParameters: domain.ModelParameters{Model: "model", ContextWindow: 8192, MaxOutputTokens: 1024},
		ModelProfileID:  "model-1", ConnectionID: "provider-1", DisplayName: "Model", Enabled: true,
	}
	require.True(t, valid.valid("https://api.example.com"), "legacy snapshots without the field stay valid")
	withRevision := valid
	withRevision.ModelProfileRevision = 2
	require.True(t, withRevision.valid("https://api.example.com"))
	for _, revision := range []int64{-1, domain.MaximumSafeInteger + 1} {
		rejected := valid
		rejected.ModelProfileRevision = revision
		require.False(t, rejected.valid("https://api.example.com"), "revision %d must be rejected", revision)
	}
}

func TestExecutionTextUsesACPStringLength(t *testing.T) {
	// Zod's string length is measured in UTF-16 code units, not UTF-8 bytes.
	require.True(t, executionText(strings.Repeat("\U0001F600", 100)))
	require.False(t, executionText(strings.Repeat("\U0001F600", 101)))
	require.True(t, executionText(strings.Repeat("\u4e2d", 200)))
	require.False(t, executionText(string([]byte{0xff})))
}

func TestSettlementDeadlineMustHaveARepresentableUTCYear(t *testing.T) {
	request := AgentSettlementRequest{OrganizationID: "org1", AgentID: "agent1", OperationID: "operation1", MinimumRevision: 1, Mode: "wait"}
	for _, deadline := range []time.Time{time.Time{}, time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(-1, 1, 1, 0, 0, 0, 0, time.UTC)} {
		request.DeadlineAt = deadline
		require.ErrorIs(t, request.Validate(), ErrInvalidExecutionConfiguration)
	}
	request.DeadlineAt = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	require.NoError(t, request.Validate())
}

func TestExecutionEndpointsUseCanonicalIPAddresses(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.256:8093/mcp", "http://999.1.1.1/mcp", "http://runtime.123/mcp", "http://runtime.0x10/mcp", "http://2001:db8::1:80/mcp"} {
		require.False(t, executionEndpoint(endpoint), endpoint)
	}
	for _, endpoint := range []string{"http://127.0.0.1:8093/mcp", "http://runtime-1:8093/mcp", "http://runtime.internal/mcp", "http://[fd00::1]:8093/mcp"} {
		require.True(t, executionEndpoint(endpoint), endpoint)
	}
}
