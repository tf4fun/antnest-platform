package egressclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func policyTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestPolicyRevisionReadsOpaqueIDExactlyOnce(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"builtin/deny-all", "team/shared%policy?key#part"} {
		t.Run(id, func(t *testing.T) {
			ref := ports.NetworkPolicyReference{PolicyID: id, Revision: 3}
			expected := ports.NetworkPolicyRevision{NetworkPolicyReference: ref, Spec: ports.NetworkPolicySpec{SchemaVersion: 1, Action: "deny_all"}, Digest: "sha256:" + strings.Repeat("a", 64)}
			client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.EscapedPath() != "/internal/policies/"+url.PathEscape(id)+"/revisions/3" || r.URL.RawQuery != "" {
					t.Errorf("request=%s %s", r.Method, r.URL)
				}
				if err := json.NewEncoder(w).Encode(expected); err != nil {
					t.Error(err)
				}
			})
			result, err := client.GetPolicyRevision(context.Background(), ref)
			if err != nil || result != expected {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}

func TestPolicyAssignmentWritePreservesCASAndDoesNotReadAfterAcknowledgement(t *testing.T) {
	t.Parallel()
	var requests []ports.SetNetworkPolicy
	mutation := ports.SetNetworkPolicy{NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}, ExpectedResourceVersion: 7}
	client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/internal/agent-policy-assignments/agent-1" {
			t.Errorf("request=%s %s", r.Method, r.URL)
		}
		var input ports.SetNetworkPolicy
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		requests = append(requests, input)
		if err := json.NewEncoder(w).Encode(ports.NetworkPolicyAssignment{AgentID: "agent-1", NetworkPolicyReference: mutation.NetworkPolicyReference, ResourceVersion: 8}); err != nil {
			t.Error(err)
		}
	})
	for range 2 {
		result, err := client.SetAgentPolicyAssignment(context.Background(), "agent-1", mutation)
		if err != nil || result.ResourceVersion != 8 {
			t.Fatalf("result=%+v error=%v", result, err)
		}
	}
	if !reflect.DeepEqual(requests, []ports.SetNetworkPolicy{mutation, mutation}) {
		t.Fatalf("requests=%+v", requests)
	}
}

func TestPolicyAssignmentRejectsMalformedOrMismatchedResponses(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`{"agent_id":"other","policy_id":"builtin/deny-all","revision":1,"resource_version":1}`,
		`{"agent_id":"agent-1","policy_id":"has space","revision":1,"resource_version":1}`,
		`{"agent_id":"agent-1","policy_id":"builtin/deny-all","revision":0,"resource_version":1}`,
		`{"agent_id":"agent-1","policy_id":"builtin/deny-all","revision":1,"resource_version":0}`,
		`null`, `{`, strings.Repeat("x", maximumResponseBytes+1),
	} {
		client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			if _, err := io.WriteString(w, body); err != nil {
				t.Error(err)
			}
		})
		_, err := client.GetAgentPolicyAssignment(context.Background(), "agent-1")
		assertPolicyDependency(t, err, "invalid_response")
	}
}

func TestPolicyRevisionRejectsDifferentOrUnsupportedContents(t *testing.T) {
	t.Parallel()
	ref := ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}
	for _, change := range []func(*ports.NetworkPolicyRevision){
		func(r *ports.NetworkPolicyRevision) { r.PolicyID = "other" }, func(r *ports.NetworkPolicyRevision) { r.Revision = 2 },
		func(r *ports.NetworkPolicyRevision) { r.Spec.SchemaVersion = 2 }, func(r *ports.NetworkPolicyRevision) { r.Spec.Action = "unknown" },
		func(r *ports.NetworkPolicyRevision) { r.Digest = "not-a-digest" },
	} {
		revision := ports.NetworkPolicyRevision{NetworkPolicyReference: ref, Spec: ports.NetworkPolicySpec{SchemaVersion: 1, Action: "allow_all"}, Digest: "sha256:" + strings.Repeat("a", 64)}
		change(&revision)
		client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			if err := json.NewEncoder(w).Encode(revision); err != nil {
				t.Error(err)
			}
		})
		_, err := client.GetPolicyRevision(context.Background(), ref)
		assertPolicyDependency(t, err, "invalid_response")
	}
}

func TestPolicyErrorsAreBoundedAndNeverRetried(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		status int
		code   string
		want   string
	}{
		{409, "resource_version_conflict", "resource_version_conflict"},
		{503, "cleanup_failed", "cleanup_failed"}, {404, "policy_revision_not_found", "policy_revision_not_found"},
		{503, "secret-upstream-message", "invalid_response"},
	} {
		calls := 0
		client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			calls++
			w.WriteHeader(scenario.status)
			if err := json.NewEncoder(w).Encode(map[string]any{"code": scenario.code, "retryable": true}); err != nil {
				t.Error(err)
			}
		})
		_, err := client.SetAgentPolicyAssignment(context.Background(), "agent-1", ports.SetNetworkPolicy{NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}, ExpectedResourceVersion: 1})
		assertPolicyDependency(t, err, scenario.want)
		if calls != 1 {
			t.Fatalf("retried request %d times", calls)
		}
	}
}

func assertPolicyDependency(t *testing.T, err error, code string) {
	t.Helper()
	var failure *ports.DependencyError
	if !errors.As(err, &failure) || failure.Service != "runtime-egress" || failure.Code != code {
		t.Fatalf("dependency error=%v", err)
	}
}

func TestPolicyMutationDoesNotFollowRedirects(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/redirected" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		http.Redirect(w, r, "/redirected", http.StatusTemporaryRedirect)
	})
	_, err := client.SetAgentPolicyAssignment(t.Context(), "agent-1", ports.SetNetworkPolicy{
		NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}, ExpectedResourceVersion: 7,
	})
	assertPolicyDependency(t, err, "invalid_response")
	if calls.Load() != 1 {
		t.Fatalf("policy command followed a redirect: %d requests", calls.Load())
	}
}

func TestPolicyRequestCancellationStopsWithoutRetry(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	stopped := make(chan struct{})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	client := policyTestClient(t, func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(stopped)
	})
	result := make(chan error, 1)
	go func() {
		_, err := client.GetAgentPolicyAssignment(ctx, "agent-1")
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not reach Egress")
	}
	cancel()
	assertPolicyDependency(t, <-result, "control_plane_unavailable")
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled request remained active")
	}
}

func TestPolicyMutationRejectsUnacknowledgedAssignment(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`{"agent_id":"agent-1","policy_id":"wrong","revision":1,"resource_version":8}`,
		`{"agent_id":"agent-1","policy_id":"builtin/allow-all","revision":2,"resource_version":8}`,
		`{"agent_id":"agent-1","policy_id":"builtin/allow-all","revision":1,"resource_version":9}`,
	} {
		client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			if _, err := io.WriteString(w, body); err != nil {
				t.Error(err)
			}
		})
		result, err := client.SetAgentPolicyAssignment(t.Context(), "agent-1", ports.SetNetworkPolicy{
			NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}, ExpectedResourceVersion: 7,
		})
		assertPolicyDependency(t, err, "invalid_response")
		if result != (ports.NetworkPolicyAssignment{}) {
			t.Fatalf("unacknowledged assignment returned: %+v", result)
		}
	}
}

func TestPolicyBodyCancellationIsUnavailableNotMalformed(t *testing.T) {
	t.Parallel()
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			reading := make(chan struct{})
			client := policyTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if _, err := io.Copy(io.Discard, r.Body); err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Length", "100")
				w.WriteHeader(http.StatusOK)
				if err := http.NewResponseController(w).Flush(); err != nil {
					t.Error(err)
				}
				<-r.Context().Done()
			})
			transport := client.httpClient.Transport
			client.httpClient.Transport = policyTransportFunc(func(r *http.Request) (*http.Response, error) {
				response, err := transport.RoundTrip(r)
				if err == nil {
					response.Body = &policyObservedBody{ReadCloser: response.Body, reading: reading}
				}
				return response, err
			})
			result := make(chan error, 1)
			go func() {
				var err error
				if method == http.MethodGet {
					_, err = client.GetAgentPolicyAssignment(ctx, "agent-1")
				} else {
					_, err = client.SetAgentPolicyAssignment(ctx, "agent-1", ports.SetNetworkPolicy{
						NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}, ExpectedResourceVersion: 7,
					})
				}
				result <- err
			}()
			select {
			case <-reading:
			case <-time.After(2 * time.Second):
				t.Fatal("response body read not started")
			}
			cancel()
			assertPolicyDependency(t, <-result, "control_plane_unavailable")
		})
	}
}

type policyTransportFunc func(*http.Request) (*http.Response, error)

func (transport policyTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

type policyObservedBody struct {
	io.ReadCloser
	reading chan struct{}
	once    sync.Once
}

func (body *policyObservedBody) Read(p []byte) (int, error) {
	body.once.Do(func() { close(body.reading) })
	return body.ReadCloser.Read(p)
}

func TestPolicyAttachmentReadUsesBoundedErrors(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"code":"invalid_request"}`, `{"code":"private-upstream-data"}`} {
		client := policyTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
			if _, err := io.WriteString(w, body); err != nil {
				t.Error(err)
			}
		})
		_, err := client.GetAgentNetwork(t.Context(), "agent-1")
		assertPolicyDependency(t, err, "invalid_response")
	}
}
