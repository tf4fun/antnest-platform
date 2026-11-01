package egressclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func metadataResponse(spec ports.NetworkPolicySpec, ref ports.NetworkPolicyReference) map[string]any {
	canonical, _ := json.Marshal(spec)
	sum := sha256.Sum256(canonical)
	return map[string]any{
		"policy_id":      ref.PolicyID,
		"revision":       ref.Revision,
		"schema_version": spec.SchemaVersion,
		"digest":         "sha256:" + hex.EncodeToString(sum[:]),
	}
}

func TestPutPolicyRevisionAcceptsActualMetadataResponse(t *testing.T) {
	specs := []struct {
		name string
		spec ports.NetworkPolicySpec
	}{
		{
			name: "v1_allow_all",
			spec: ports.NetworkPolicySpec{SchemaVersion: 1, Action: "allow_all"},
		},
		{
			name: "v2_empty_rules",
			spec: ports.NetworkPolicySpec{SchemaVersion: 2, Default: "deny", Rules: []ports.NetworkPolicyRule{}},
		},
		{
			name: "v2_domain_tcp_equal_range",
			spec: ports.NetworkPolicySpec{
				SchemaVersion: 2,
				Default:       "deny",
				Rules: []ports.NetworkPolicyRule{
					{
						Action:   "allow",
						Domains:  []string{"api.github.com"},
						Ports:    []ports.NetworkPolicyPort{{From: 443, To: 443, Range: true}},
						Protocol: "tcp",
					},
				},
			},
		},
	}
	for _, scenario := range specs {
		t.Run(scenario.name, func(t *testing.T) {
			var spec ports.NetworkPolicySpec
			canonical, err := json.Marshal(scenario.spec)
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(canonical, &spec); err != nil {
				t.Fatal(err)
			}
			ref, err := spec.Reference("org-1", "agent-1")
			if err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPut ||
					r.URL.EscapedPath() != "/internal/policies/"+url.PathEscape(ref.PolicyID)+"/revisions/1" {
					t.Errorf("request=%s %s", r.Method, r.URL)
				}
				if err := json.NewEncoder(w).Encode(metadataResponse(spec, ref)); err != nil {
					t.Error(err)
				}
			})
			revision, err := client.PutPolicyRevision(context.Background(), ref, spec)
			if err != nil {
				t.Fatalf("metadata response rejected: %v", err)
			}
			if calls.Load() != 1 {
				t.Fatalf("expected exactly one PUT, got %d", calls.Load())
			}
			expected := metadataResponse(spec, ref)
			if revision.NetworkPolicyReference != ref ||
				!revision.Spec.Equal(spec) ||
				revision.Digest != expected["digest"] ||
				!strings.HasPrefix(revision.Digest, "sha256:") {
				t.Fatalf("revision=%+v want ref=%+v digest=%s", revision, ref, expected["digest"])
			}
		})
	}
}
