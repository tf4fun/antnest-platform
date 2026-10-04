package telemetry

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeConnectionFailuresRetainSafeTraceClassifications(t *testing.T) {
	for _, code := range []string{"runtime_not_found", "runtime_connection_stale", "runtime_connection_unavailable", "service_unauthenticated", "caller_not_allowed"} {
		t.Run(code, func(t *testing.T) {
			require.Equal(t, code, SafeCode(code))
			kind, message := safeError(&ports.DependencyError{Service: "runtime-controller", Code: code})
			require.Equal(t, code, kind)
			require.Equal(t, "dependency returned "+code, message)
		})
	}
	require.Equal(t, "unclassified_error", SafeCode("secret-unregistered-runtime-code"))
}
