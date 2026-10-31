package egressclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
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

func egressSpecDigest(t *testing.T, spec ports.NetworkPolicySpec) string {
	t.Helper()
	canonical, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func egressMetadataBody(ref ports.NetworkPolicyReference, spec ports.NetworkPolicySpec, digest string) string {
	return `{"policy_id":"` + ref.PolicyID + `","revision":` + strconv.FormatUint(ref.Revision, 10) +
		`,"schema_version":` + strconv.Itoa(spec.SchemaVersion) + `,"digest":"` + digest + `"}`
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
		_, _ = io.WriteString(w, egressMetadataBody(ref, spec, egressSpecDigest(t, spec)))
	})
	result, err := client.PutPolicyRevision(context.Background(), ref, spec)
	if err != nil || result.NetworkPolicyReference != ref || !result.Spec.Equal(spec) ||
		result.Digest != egressSpecDigest(t, spec) {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestPutPolicyRevisionRejectsCorruptMetadataAndConflict(t *testing.T) {
	t.Parallel()
	ref := ports.NetworkPolicyReference{PolicyID: "custom/" + strings.Repeat("c", 64), Revision: 1}
	spec := egressV2Spec(t)
	valid := `{"policy_id":"` + ref.PolicyID + `","revision":1,"schema_version":2,"digest":"` + egressSpecDigest(t, spec) + `"}`
	corrupt := []struct {
		name string
		body string
	}{
		{"wrong_ref", strings.Replace(valid, `"policy_id":"`+ref.PolicyID+`"`, `"policy_id":"custom/other"`, 1)},
		{"wrong_revision", strings.Replace(valid, `"revision":1`, `"revision":2`, 1)},
		{"wrong_schema", strings.Replace(valid, `"schema_version":2`, `"schema_version":1`, 1)},
		{"missing_schema", `{"policy_id":"` + ref.PolicyID + `","revision":1,"digest":"` + egressSpecDigest(t, spec) + `"}`},
		{"null_schema", strings.Replace(valid, `"schema_version":2`, `"schema_version":null`, 1)},
		{"bad_digest", strings.Replace(valid, `"digest":"sha256:`, `"digest":"md5:`, 1)},
		{"wrong_digest", strings.Replace(valid, egressSpecDigest(t, spec), "sha256:"+strings.Repeat("f", 64), 1)},
		{"unknown_field", strings.TrimSuffix(valid, "}") + `,"extra":1}`},
		{"duplicate_field", `{"policy_id":"` + ref.PolicyID + `","policy_id":"` + ref.PolicyID + `","revision":1,"schema_version":2,"digest":"` + egressSpecDigest(t, spec) + `"}`},
		{"injected_spec", strings.TrimSuffix(valid, "}") + `,"spec":` + egressV2SpecJSON + `}`},
	}
	for _, scenario := range corrupt {
		t.Run(scenario.name, func(t *testing.T) {
			client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, scenario.body)
			})
			var failure *ports.DependencyError
			if _, err := client.PutPolicyRevision(context.Background(), ref, spec); err == nil || !errors.As(err, &failure) || failure.Code != "invalid_response" {
				t.Fatalf("corrupt metadata error=%v body=%s", err, scenario.body)
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
