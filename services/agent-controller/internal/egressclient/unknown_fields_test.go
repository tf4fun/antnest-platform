package egressclient

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestPolicyResponsesTolerateUnknownResponseFields(t *testing.T) {
	t.Parallel()
	ref := ports.NetworkPolicyReference{PolicyID: "custom/" + strings.Repeat("a", 64), Revision: 1}
	spec := egressV2Spec(t)
	spec.Rules[0].Ports[0].Range = true
	metadata := strings.TrimSuffix(egressMetadataBody(ref, spec, egressSpecDigest(t, spec)), "}") +
		`,"spec":` + egressV2SpecJSON + `,"future_extension":{"nested":[1,2]}}`
	revision := `{"policy_id":"` + ref.PolicyID + `","revision":1,` +
		`"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"],` +
		`"ports":[{"from":443,"to":443,"future_port":true}],"future_rule":true}],"future_spec":{"nested":1}},` +
		`"digest":"` + egressSpecDigest(t, spec) + `","future_top":{"cursor":"opaque"}}`
	client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut:
			_, _ = io.WriteString(w, metadata)
		case r.Method == http.MethodGet:
			_, _ = io.WriteString(w, revision)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
	})
	published, err := client.PutPolicyRevision(context.Background(), ref, spec)
	if err != nil || published.NetworkPolicyReference != ref || !published.Spec.Equal(spec) ||
		published.Digest != egressSpecDigest(t, spec) {
		t.Fatalf("put result=%+v error=%v", published, err)
	}
	result, err := client.GetPolicyRevision(context.Background(), ref)
	if err != nil || result.NetworkPolicyReference != ref || !result.Spec.Equal(spec) ||
		result.Digest != egressSpecDigest(t, spec) {
		t.Fatalf("get result=%+v error=%v", result, err)
	}
}
