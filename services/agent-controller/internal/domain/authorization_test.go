package domain

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDefaultAuthorizationNormalization(t *testing.T) {
	t.Parallel()
	rules := []ToolRule{
		{Source: "runtime", SourceID: "runtime", ToolName: "write", Decision: "allow"},
		{Source: "runtime", SourceID: "runtime", ToolName: "read", Decision: "deny"},
	}
	normalized, err := NormalizeDefaultAuthorization(Authorization{Mode: AuthorizationApprove, ToolRules: rules})
	require.NoError(t, err)
	require.Equal(t, "read", normalized.ToolRules[0].ToolName)
	require.Equal(t, "write", rules[0].ToolName, "normalization must not mutate the caller")
	empty, err := NormalizeDefaultAuthorization(Authorization{Mode: AuthorizationAuto})
	require.NoError(t, err)
	require.NotNil(t, empty.ToolRules)
	rules = make([]ToolRule, 129)
	for i := range rules {
		rules[i] = ToolRule{Source: "runtime", SourceID: "runtime", ToolName: fmt.Sprintf("tool_%d", i), Decision: "allow"}
	}
	_, err = NormalizeDefaultAuthorization(Authorization{Mode: AuthorizationAuto, ToolRules: rules})
	require.Error(t, err)
	_, err = NormalizeDefaultAuthorization(Authorization{Mode: AuthorizationAuto, ToolRules: rules[:128]})
	require.NoError(t, err)
}
