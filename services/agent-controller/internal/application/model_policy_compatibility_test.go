package application

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLegacyTemplateModelPolicyInputFingerprintKeepsOriginalBytes(t *testing.T) {
	for _, item := range []struct {
		name     string
		input    any
		original string
	}{
		{"create", CreateTemplateInput{RequestID: "request", OrganizationID: "org", TemplateKey: "template", Name: "Template", ModelProfileID: "model", MaxModelRequests: 8, ContextPolicyVersion: "context-v1"},
			`{"RequestID":"request","OrganizationID":"org","TemplateKey":"template","Name":"Template","ModelProfileID":"model","FallbackModelProfileIDs":null,"SystemPrompt":"","MaxModelRequests":8,"ContextPolicyVersion":"context-v1","Runtime":{"image_ref":"","resources":{"memory_bytes":0,"pids_limit":0,"tmpfs_bytes":0}},"SkillRefs":null}`},
		{"revise", ReviseTemplateInput{RequestID: "request", OrganizationID: "org", TemplateID: "template", Name: "Template", ModelProfileID: "model", MaxModelRequests: 8, ContextPolicyVersion: "context-v1"},
			`{"RequestID":"request","OrganizationID":"org","TemplateID":"template","Name":"Template","ModelProfileID":"model","FallbackModelProfileIDs":null,"SystemPrompt":"","MaxModelRequests":8,"ContextPolicyVersion":"context-v1","Runtime":{"image_ref":"","resources":{"memory_bytes":0,"pids_limit":0,"tmpfs_bytes":0}},"SkillRefs":null}`},
	} {
		t.Run(item.name, func(t *testing.T) {
			encoded, err := json.Marshal(item.input)
			require.NoError(t, err)
			require.Equal(t, item.original, string(encoded))
			expected := sha256.Sum256([]byte(item.original))
			actual, err := requestFingerprint(item.input)
			require.NoError(t, err)
			require.Equal(t, hex.EncodeToString(expected[:]), actual)
		})
	}
}
