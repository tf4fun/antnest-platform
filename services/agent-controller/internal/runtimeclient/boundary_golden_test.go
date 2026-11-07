package runtimeclient_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/contracttest"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/egressclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/identityclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/runtimeclient"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func readGoldenDocument(t *testing.T, rel string) map[string]any {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("../../../../contracts", rel))
	require.NoError(t, err, "read golden %s", rel)
	if strings.HasPrefix(rel, "runtime/") || strings.HasPrefix(rel, "egress/") {
		contracttest.ValidateGolden(t, rel, contents)
	}
	var document map[string]any
	require.NoError(t, json.Unmarshal(contents, &document), "parse golden %s", rel)
	return document
}

func cloneDocument(t *testing.T, document map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(document)
	require.NoError(t, err)
	var clone map[string]any
	require.NoError(t, json.Unmarshal(encoded, &clone))
	return clone
}

func withFutureFields(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed)+1)
		out["x_future_field"] = float64(1)
		for key, item := range typed {
			out[key] = withFutureFields(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = withFutureFields(item)
		}
		return out
	default:
		return typed
	}
}

func goldenClient[T any](t *testing.T, create func(string, time.Duration, *http.Client) (T, error), body any, check func(*http.Request)) T {
	t.Helper()
	encoded, err := json.Marshal(body)
	require.NoError(t, err)
	client, err := create("http://upstream.internal", 5*time.Second, &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if check != nil {
				check(request)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header: http.Header{
					"Content-Type":  []string{"application/json"},
					"Cache-Control": []string{"no-store"},
				},
				Body:    io.NopCloser(strings.NewReader(string(encoded))),
				Request: request,
			}, nil
		}),
	})
	require.NoError(t, err)
	return client
}

func TestGoldenRuntimeInspection(t *testing.T) {
	document := readGoldenDocument(t, "runtime/examples/rc-inspection.healthy.json")
	baseline, err := goldenClient(t, runtimeclient.New, document, nil).InspectRuntime(context.Background(), "agent-1")
	require.NoError(t, err)
	require.Equal(t, "agent-1", baseline.AgentID)
	require.Equal(t, "healthy", baseline.Health)
	require.Equal(t, "running", baseline.Phase)
	extended, err := goldenClient(t, runtimeclient.New, withFutureFields(document), nil).InspectRuntime(context.Background(), "agent-1")
	require.NoError(t, err)
	require.True(t, reflect.DeepEqual(extended, baseline), "extended=%+v baseline=%+v", extended, baseline)
}

func TestGoldenRuntimeObservations(t *testing.T) {
	for _, name := range []string{"rc-observations.current", "rc-observations.n-1"} {
		t.Run(name, func(t *testing.T) {
			document := readGoldenDocument(t, "runtime/examples/"+name+".json")
			var path string
			baseline, err := goldenClient(t, runtimeclient.New, document, func(r *http.Request) { path = r.URL.Path }).ListRuntimeObservations(context.Background(), 0, 500)
			require.NoError(t, err)
			require.Equal(t, "/internal/runtime-observations", path)
			require.Len(t, baseline.Observations, 3)
			require.Equal(t, uint64(3), baseline.NextSequence)
			require.Equal(t, uint64(1), baseline.Observations[0].Sequence)
			require.Equal(t, "reconciled", baseline.Observations[0].Kind)
			extended, err := goldenClient(t, runtimeclient.New, withFutureFields(document), nil).ListRuntimeObservations(context.Background(), 0, 500)
			require.NoError(t, err)
			require.True(t, reflect.DeepEqual(extended, baseline), "extended=%+v baseline=%+v", extended, baseline)
		})
	}
}

func TestGoldenRuntimeObservationsRejectUnsupportedMarkers(t *testing.T) {
	document := readGoldenDocument(t, "runtime/examples/rc-observations.current.json")
	for _, version := range []any{float64(0), float64(2), float64(99), nil, "1", 1.5, float64(-1)} {
		t.Run(fmt.Sprintf("%v", version), func(t *testing.T) {
			broken := cloneDocument(t, document)
			broken["observations"].([]any)[0].(map[string]any)["schema_version"] = version
			_, err := goldenClient(t, runtimeclient.New, withFutureFields(broken), nil).ListRuntimeObservations(context.Background(), 0, 500)
			require.Error(t, err, "schema_version %v accepted", version)
		})
	}
}

func TestGoldenIdentityResolvePrincipal(t *testing.T) {
	document := readGoldenDocument(t, "identity/examples/resolve-principal.member.json")
	baseline, err := goldenClient(t, identityclient.New, document, nil).ResolvePrincipal(context.Background(), "org-1", "user-1")
	require.NoError(t, err)
	require.True(t, baseline.Active)
	require.Equal(t, "membership-1", baseline.MembershipID)
	require.Equal(t, "user-1", baseline.UserID)
	extended, err := goldenClient(t, identityclient.New, withFutureFields(document), nil).ResolvePrincipal(context.Background(), "org-1", "user-1")
	require.NoError(t, err)
	require.True(t, reflect.DeepEqual(extended, baseline))
}

func TestGoldenEgressAgentNetwork(t *testing.T) {
	for _, name := range []string{"network.closed", "network.open"} {
		t.Run(name, func(t *testing.T) {
			document := readGoldenDocument(t, "egress/examples/"+name+".json")
			baseline, err := goldenClient(t, egressclient.New, document, nil).GetAgentNetwork(context.Background(), "agent-1")
			require.NoError(t, err)
			require.Equal(t, "agent-1", baseline.AgentID)
			extended, err := goldenClient(t, egressclient.New, withFutureFields(document), nil).GetAgentNetwork(context.Background(), "agent-1")
			require.NoError(t, err)
			require.True(t, reflect.DeepEqual(extended, baseline))
		})
	}
}

func TestGoldenEgressPolicyAssignment(t *testing.T) {
	document := readGoldenDocument(t, "egress/examples/assignment.current.json")
	baseline, err := goldenClient(t, egressclient.New, document, nil).GetAgentPolicyAssignment(context.Background(), "agent-1")
	require.NoError(t, err)
	require.Equal(t, "builtin/allow-all", baseline.PolicyID)
	require.Equal(t, uint64(1), baseline.Revision)
	extended, err := goldenClient(t, egressclient.New, withFutureFields(document), nil).GetAgentPolicyAssignment(context.Background(), "agent-1")
	require.NoError(t, err)
	require.True(t, reflect.DeepEqual(extended, baseline))
}

func TestGoldenEgressPolicyRevision(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		policyID string
		revision uint64
	}{
		{"policy.v1", "builtin/allow-all", 1},
		{"policy.v2", "custom/policy-v2", 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			document := readGoldenDocument(t, "egress/examples/"+fixture.name+".json")
			ref := ports.NetworkPolicyReference{PolicyID: fixture.policyID, Revision: fixture.revision}
			baseline, err := goldenClient(t, egressclient.New, document, nil).GetPolicyRevision(context.Background(), ref)
			require.NoError(t, err)
			require.Equal(t, fixture.policyID, baseline.PolicyID)
			require.Equal(t, fixture.revision, baseline.Revision)
			extended, err := goldenClient(t, egressclient.New, withFutureFields(document), nil).GetPolicyRevision(context.Background(), ref)
			require.NoError(t, err)
			require.True(t, reflect.DeepEqual(extended, baseline))
		})
	}
}

func TestGoldenEgressPutPolicyRevision(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		policyID string
		revision uint64
	}{
		{"policy-metadata.v1", "builtin/allow-all", 1},
		{"policy-metadata.v2", "custom/policy-v2", 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			policy := readGoldenDocument(t, fmt.Sprintf("egress/examples/policy%s.json", fixture.name[len("policy-metadata"):]))
			var spec ports.NetworkPolicySpec
			require.NoError(t, json.Unmarshal(mustMarshalBytes(t, policy["spec"]), &spec))
			document := readGoldenDocument(t, "egress/examples/"+fixture.name+".json")
			ref := ports.NetworkPolicyReference{PolicyID: fixture.policyID, Revision: fixture.revision}
			baseline, err := goldenClient(t, egressclient.New, document, nil).PutPolicyRevision(context.Background(), ref, spec)
			require.NoError(t, err)
			require.Equal(t, fixture.policyID, baseline.PolicyID)
			require.Equal(t, fixture.revision, baseline.Revision)
			require.Equal(t, document["digest"], baseline.Digest)
			extended, err := goldenClient(t, egressclient.New, withFutureFields(document), nil).PutPolicyRevision(context.Background(), ref, spec)
			require.NoError(t, err)
			require.True(t, reflect.DeepEqual(extended, baseline))
		})
	}
}

func mustMarshalBytes(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	return encoded
}

func TestGoldenRejectsCorruptedKnownFields(t *testing.T) {
	t.Run("inspection foreign agent", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "runtime/examples/rc-inspection.healthy.json"))
		broken["agent_id"] = "agent-2"
		_, err := goldenClient(t, runtimeclient.New, withFutureFields(broken), nil).InspectRuntime(context.Background(), "agent-1")
		require.Error(t, err)
	})
	t.Run("observation sequence zero", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "runtime/examples/rc-observations.current.json"))
		broken["observations"].([]any)[0].(map[string]any)["sequence"] = float64(0)
		_, err := goldenClient(t, runtimeclient.New, withFutureFields(broken), nil).ListRuntimeObservations(context.Background(), 0, 500)
		require.Error(t, err)
	})
	t.Run("observation bad observed_at", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "runtime/examples/rc-observations.current.json"))
		broken["observations"].([]any)[0].(map[string]any)["observed_at"] = "not-a-time"
		_, err := goldenClient(t, runtimeclient.New, withFutureFields(broken), nil).ListRuntimeObservations(context.Background(), 0, 500)
		require.Error(t, err)
	})
	t.Run("identity foreign user", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "identity/examples/resolve-principal.member.json"))
		broken["principal"].(map[string]any)["user_id"] = "user-2"
		_, err := goldenClient(t, identityclient.New, withFutureFields(broken), nil).ResolvePrincipal(context.Background(), "org-1", "user-1")
		require.Error(t, err)
	})
	t.Run("identity active wrong type", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "identity/examples/resolve-principal.member.json"))
		broken["principal"].(map[string]any)["active"] = "yes"
		_, err := goldenClient(t, identityclient.New, withFutureFields(broken), nil).ResolvePrincipal(context.Background(), "org-1", "user-1")
		require.Error(t, err)
	})
	t.Run("egress foreign agent", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "egress/examples/network.closed.json"))
		broken["agent_id"] = "agent-2"
		_, err := goldenClient(t, egressclient.New, withFutureFields(broken), nil).GetAgentNetwork(context.Background(), "agent-1")
		require.Error(t, err)
	})
	t.Run("egress invalid endpoint ipv4", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "egress/examples/network.closed.json"))
		broken["egress_endpoint"].(map[string]any)["ipv4"] = "999.0.0.1"
		_, err := goldenClient(t, egressclient.New, withFutureFields(broken), nil).GetAgentNetwork(context.Background(), "agent-1")
		require.Error(t, err)
	})
	t.Run("policy unsupported schema_version", func(t *testing.T) {
		broken := cloneDocument(t, readGoldenDocument(t, "egress/examples/policy.v1.json"))
		broken["spec"].(map[string]any)["schema_version"] = float64(99)
		ref := ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}
		_, err := goldenClient(t, egressclient.New, withFutureFields(broken), nil).GetPolicyRevision(context.Background(), ref)
		require.Error(t, err)
	})
}
