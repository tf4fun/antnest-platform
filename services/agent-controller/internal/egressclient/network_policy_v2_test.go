package egressclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const egressV2SpecJSON = `{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"],"ports":[443]}]}`

func egressV2Spec(t *testing.T) ports.NetworkPolicySpec {
	t.Helper()
	var spec ports.NetworkPolicySpec
	if err := json.Unmarshal([]byte(egressV2SpecJSON), &spec); err != nil {
		t.Fatal(err)
	}
	return spec
}

func TestPutPolicyRevisionPublishesEscapedPathAndSpecOnlyBody(t *testing.T) {
	t.Parallel()
	ref := ports.NetworkPolicyReference{PolicyID: "custom/" + strings.Repeat("a", 64), Revision: 1}
	spec := egressV2Spec(t)
	client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.EscapedPath() != "/internal/policies/"+url.PathEscape(ref.PolicyID)+"/revisions/1" {
			t.Errorf("request=%s %s", r.Method, r.URL)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"spec":`+egressV2SpecJSON+`}` {
			t.Errorf("body=%s", body)
		}
		if err := json.NewEncoder(w).Encode(map[string]any{
			"policy_id": ref.PolicyID, "revision": 1,
			"spec": json.RawMessage(egressV2SpecJSON), "digest": "sha256:" + strings.Repeat("b", 64),
		}); err != nil {
			t.Error(err)
		}
	})
	result, err := client.PutPolicyRevision(context.Background(), ref, spec)
	if err != nil || result.NetworkPolicyReference != ref || !result.Spec.Equal(spec) {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestPutPolicyRevisionRejectsCorruptEchoAndConflictStatus(t *testing.T) {
	t.Parallel()
	ref := ports.NetworkPolicyReference{PolicyID: "custom/" + strings.Repeat("c", 64), Revision: 1}
	spec := egressV2Spec(t)
	corrupt := []struct {
		name string
		body string
	}{
		{"wrong_ref", `{"policy_id":"custom/other","revision":1,"spec":` + egressV2SpecJSON + `,"digest":"sha256:` + strings.Repeat("b", 64) + `"}`},
		{"spec_mismatch", `{"policy_id":"` + ref.PolicyID + `","revision":1,"spec":{"schema_version":1,"action":"deny_all"},"digest":"sha256:` + strings.Repeat("b", 64) + `"}`},
		{"bad_digest", `{"policy_id":"` + ref.PolicyID + `","revision":1,"spec":` + egressV2SpecJSON + `,"digest":"md5:abc"}`},
		{"unknown_field", `{"policy_id":"` + ref.PolicyID + `","revision":1,"spec":` + egressV2SpecJSON + `,"digest":"sha256:` + strings.Repeat("b", 64) + `","x":1}`},
		{"duplicate_field", `{"policy_id":"` + ref.PolicyID + `","policy_id":"` + ref.PolicyID + `","revision":1,"spec":` + egressV2SpecJSON + `,"digest":"sha256:` + strings.Repeat("b", 64) + `"}`},
		{"null_spec", `{"policy_id":"` + ref.PolicyID + `","revision":1,"spec":null,"digest":"sha256:` + strings.Repeat("b", 64) + `"}`},
	}
	for _, scenario := range corrupt {
		t.Run(scenario.name, func(t *testing.T) {
			client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, scenario.body)
			})
			var failure *ports.DependencyError
			if _, err := client.PutPolicyRevision(context.Background(), ref, spec); err == nil || !errors.As(err, &failure) || failure.Code != "invalid_response" {
				t.Fatalf("corrupt echo error=%v body=%s", err, scenario.body)
			}
		})
	}
	client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"code":"policy_revision_conflict","retryable":false}`)
	})
	var failure *ports.DependencyError
	if _, err := client.PutPolicyRevision(context.Background(), ref, spec); err == nil || !errors.As(err, &failure) || failure.Code != "policy_revision_conflict" {
		t.Fatalf("conflict error=%v", err)
	}
}
