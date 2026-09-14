package runtimeclient

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionEndpointCapacityBound(t *testing.T) {
	prefix := "http://runtime/mcp?x="
	boundary := prefix + strings.Repeat("&", ports.MaximumExecutionEndpointBytes-len(prefix))
	require.True(t, validMCPEndpoint(boundary))
	require.False(t, validMCPEndpoint(boundary+"x"))
	require.False(t, validMCPEndpoint(prefix+strings.Repeat("经验", 400)))
}
