package acpclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func deltaFixture() ports.ExecutionDelta {
	return ports.ExecutionDelta{SchemaVersion: 2, OrganizationID: "org-1", BaseRevision: 2, Revision: 3,
		Providers: ports.ExecutionCollectionDelta[ports.ExecutionProvider]{
			Upserts: []ports.ExecutionProvider{{ConnectionID: "provider-1", ProviderKey: "deepseek", RequestProtocol: "openai_chat_completions",
				BaseURL: "https://api.deepseek.com", Enabled: true, CredentialRevision: "credential-current",
				Credential: &ports.ExecutionCredential{Ref: "provider-1", Version: "credential-current"}}},
			Deletes: []string{},
		},
		Models:             ports.ExecutionCollectionDelta[ports.ExecutionModel]{Upserts: []ports.ExecutionModel{}, Deletes: []string{"model-old"}},
		Agents:             ports.ExecutionCollectionDelta[ports.ExecutionAgent]{Upserts: []ports.ExecutionAgent{}, Deletes: []string{}},
		OrganizationBudget: &domain.OrganizationBudget{Revision: 4, UnknownCost: "deny"}}
}

func TestExecutionV2ClientDigestAndDeltaRoundTrip(t *testing.T) {
	hex := strings.Repeat("a", 64)
	var digestBody, deltaBody json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/rpc/agent-acp/get-execution-digest":
			digestBody = raw
			_ = json.NewEncoder(w).Encode(map[string]any{
				"organization_id": "org-1", "schema_version": 2, "revision": 3, "digest": hex,
				"providers":                  []any{map[string]any{"id": "provider-1", "digest": hex}},
				"models":                     []any{},
				"agents":                     []any{},
				"organization_budget_digest": nil,
			})
		case "/rpc/agent-acp/apply-execution-delta":
			deltaBody = raw
			_ = json.NewEncoder(w).Encode(ports.ExecutionAcknowledgement{OrganizationID: "org-1", AppliedRevision: 3})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	v2, ok := interface{}(client).(ports.ExecutionV2Client)
	require.True(t, ok)
	digest, err := v2.GetExecutionDigest(t.Context(), "org-1")
	require.NoError(t, err)
	require.JSONEq(t, `{"organization_id":"org-1"}`, string(digestBody))
	require.Equal(t, 2, digest.SchemaVersion)
	require.EqualValues(t, 3, digest.Revision)
	require.Equal(t, hex, *digest.Digest)
	require.Equal(t, "provider-1", digest.Providers[0].ID)
	require.Nil(t, digest.OrganizationBudgetDigest)
	ack, err := v2.ApplyExecutionDelta(t.Context(), deltaFixture())
	require.NoError(t, err)
	require.EqualValues(t, 3, ack.AppliedRevision)
	var wire struct {
		SchemaVersion      int                        `json:"schema_version"`
		Providers          json.RawMessage            `json:"providers"`
		OrganizationBudget *domain.OrganizationBudget `json:"organization_budget"`
	}
	require.NoError(t, json.Unmarshal(deltaBody, &wire))
	require.Equal(t, 2, wire.SchemaVersion)
	require.NotNil(t, wire.OrganizationBudget)
	require.Contains(t, string(wire.Providers), `"ref":"provider-1"`)
	require.NotContains(t, string(deltaBody), "secret")
}

func TestExecutionV2ClientRejectsMalformedDigests(t *testing.T) {
	hex := strings.Repeat("a", 64)
	var omitted []string
	for _, key := range []string{"organization_id", "schema_version", "revision", "digest", "providers", "models", "agents", "organization_budget_digest"} {
		fields := map[string]string{
			"organization_id": `"org-1"`, "schema_version": `2`, "revision": `3`, "digest": `"` + hex + `"`,
			"providers": `[]`, "models": `[]`, "agents": `[]`, "organization_budget_digest": `null`,
		}
		delete(fields, key)
		parts := make([]string, 0, len(fields))
		for name, value := range fields {
			parts = append(parts, `"`+name+`":`+value)
		}
		omitted = append(omitted, `{`+strings.Join(parts, ",")+`}`)
	}
	for _, body := range append(omitted, []string{
		`{"organization_id":"org-2","schema_version":2,"revision":3,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":3,"revision":3,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":0,"revision":0,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":2,"revision":3,"digest":"short","providers":[],"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":2,"revision":3,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null,"extra":1}`,
		`{"organization_id":"org-1","schema_version":2,"revision":3,"digest":"` + hex + `","models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":null,"revision":3,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":2,"revision":null,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":2,"revision":3,"digest":"` + hex + `","providers":null,"models":[],"agents":[],"organization_budget_digest":null}`,
		`{"organization_id":"org-1","schema_version":2,"revision":3,"digest":"` + hex + `","providers":[],"models":[],"agents":[],"organization_budget_digest":null,"unexpected":1}`,
	}...) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		}))
		client, err := New(server.URL, time.Second, server.Client())
		require.NoError(t, err)
		v2 := interface{}(client).(ports.ExecutionV2Client)
		_, err = v2.GetExecutionDigest(t.Context(), "org-1")
		server.Close()
		var dependency *ports.DependencyError
		require.ErrorAs(t, err, &dependency, body)
		require.Equal(t, "invalid_response", dependency.Code)
	}
}

func TestExecutionV2ClientSanitizesDependencyFailures(t *testing.T) {
	for _, scenario := range []struct {
		name, method, body string
		status             int
		want               string
		retryable          bool
	}{
		{"base mismatch", "apply-execution-delta", `{"code":"configuration_base_mismatch","message":"sk-canary"}`, 409, "configuration_base_mismatch", false},
		{"conflict", "apply-execution-delta", `{"code":"configuration_conflict"}`, 409, "configuration_conflict", false},
		{"invalid delta", "apply-execution-delta", `{"code":"invalid_execution_configuration"}`, 400, "invalid_execution_configuration", false},
		{"too large", "apply-execution-delta", `{"code":"configuration_too_large"}`, 413, "configuration_too_large", false},
		{"unavailable", "apply-execution-delta", `{"code":"configuration_unavailable"}`, 503, "configuration_unavailable", true},
		{"unknown 409", "apply-execution-delta", `{"code":"anything_else","message":"sk-canary"}`, 409, "invalid_response", true},
		{"digest unavailable", "get-execution-digest", `{"code":"configuration_unavailable"}`, 503, "configuration_unavailable", true},
		{"digest invalid", "get-execution-digest", `{"code":"invalid_execution_configuration"}`, 400, "invalid_execution_configuration", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(scenario.status)
				_, _ = w.Write([]byte(scenario.body))
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			require.NoError(t, err)
			v2 := interface{}(client).(ports.ExecutionV2Client)
			var failure error
			if scenario.method == "get-execution-digest" {
				_, failure = v2.GetExecutionDigest(t.Context(), "org-1")
			} else {
				_, failure = v2.ApplyExecutionDelta(t.Context(), deltaFixture())
			}
			var dependency *ports.DependencyError
			require.ErrorAs(t, failure, &dependency)
			require.Equal(t, scenario.want, dependency.Code)
			require.Equal(t, scenario.retryable, dependency.Retryable)
			require.NotContains(t, failure.Error(), "sk-canary")
		})
	}
}

func TestExecutionV2ClientRejectsInvalidDeltaBeforeSend(t *testing.T) {
	client, err := New("http://127.0.0.1:1", time.Second, http.DefaultClient)
	require.NoError(t, err)
	v2 := interface{}(client).(ports.ExecutionV2Client)
	for _, delta := range []ports.ExecutionDelta{
		{SchemaVersion: 1, OrganizationID: "org-1", BaseRevision: 1, Revision: 2},
		{SchemaVersion: 2, OrganizationID: "org-1", BaseRevision: 0, Revision: 2},
		{SchemaVersion: 2, OrganizationID: "org-1", BaseRevision: 2, Revision: 2},
	} {
		_, err := v2.ApplyExecutionDelta(t.Context(), delta)
		require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
	}
}
