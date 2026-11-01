package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const networkPolicyV2Spec = `{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"],"ports":[443]},{"action":"allow","cidrs":["10.20.0.15/32"],"ports":[{"from":400,"to":450}]}]}`

func networkPolicyV2ViewFixture() string {
	return `{"agent_id":"agent-1","policy":{"policy_id":"custom/` + strings.Repeat("c", 64) + `","revision":1,"resource_version":7,"spec":` + networkPolicyV2Spec + `,"digest":"sha256:` + strings.Repeat("a", 64) + `"},"attachment":{"state":"closed","resource_version":4,"tunnel_ip":"private"},"organization_id":"private"}`
}

func decodeSpec(t *testing.T) any {
	t.Helper()
	var spec any
	if err := json.Unmarshal([]byte(networkPolicyV2Spec), &spec); err != nil {
		t.Fatal(err)
	}
	return spec
}

func assertNoInternalPolicyFields(t *testing.T, body string) {
	t.Helper()
	var top map[string]any
	if err := json.Unmarshal([]byte(body), &top); err != nil {
		t.Fatal(err)
	}
	if _, present := top["action"]; present {
		t.Fatalf("top-level action projected: %s", body)
	}
	for _, forbidden := range []string{`"policy_id"`, `"revision":`, `"digest"`, `"credential_ref"`, `"organization_id"`} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("internal field projected: %s in %s", forbidden, body)
		}
	}
}

func TestNetworkPolicyV2ReadProjectsFullSpecWithoutInternalFields(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, networkPolicyV2ViewFixture())
	response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodGet, networkPath, "")
	if response.Code != 200 {
		t.Fatalf("v2 spec read=%d %s", response.Code, response.Body.String())
	}
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	want := map[string]any{
		"agent_id":         "agent-1",
		"spec":             decodeSpec(t),
		"resource_version": float64(7),
		"attachment":       map[string]any{"state": "closed", "resource_version": float64(4)},
	}
	if !reflect.DeepEqual(value, want) || len(backend.calls) != 1 {
		t.Fatalf("projection=%v calls=%v", value, backend.calls)
	}
	assertNoInternalPolicyFields(t, response.Body.String())
	call := backend.calls[0]
	if call.Target != upstream.AgentController || call.Method != http.MethodGet {
		t.Fatalf("read mutated or hit the wrong service: %+v", call)
	}
}

func TestNetworkPolicyV2SpecWriteIsOneSpecOnlyCASWithDerivedAck(t *testing.T) {
	canonical := `["org-1","agent-1",` + networkPolicyV2Spec + `]`
	sum := sha256.Sum256([]byte(canonical))
	expectedID := "custom/" + hex.EncodeToString(sum[:])
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"agent_id":"agent-1","policy_id":"`+expectedID+`","revision":1,"resource_version":8,"credential_ref":"private-value"}`)
	response := requestNetworkAdmin(
		t, newTestHandler(t, backend), http.MethodPut, networkPath,
		`{"spec":`+networkPolicyV2Spec+`,"expected_resource_version":7}`,
	)
	if response.Code != 200 {
		t.Fatalf("spec-only write=%d %s", response.Code, response.Body.String())
	}
	assertNoInternalPolicyFields(t, response.Body.String())
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	if !reflect.DeepEqual(value["spec"], decodeSpec(t)) || value["resource_version"] != float64(8) || value["agent_id"] != "agent-1" {
		t.Fatalf("ack projection=%v", value)
	}
	call := backend.singleCall(t)
	var command map[string]any
	decodeBytes(t, call.Body, &command)
	if call.Target != upstream.AgentController || call.Method != http.MethodPut || call.Path != "/internal/agents/agent-1/network-policy" {
		t.Fatalf("downstream call=%+v", call)
	}
	if command["organization_id"] != "org-1" || command["actor_principal_id"] != "user-admin" ||
		command["expected_resource_version"] != float64(7) {
		t.Fatalf("trusted metadata dropped: %v", command)
	}
	if command["request_id"] == "" || command["request_id"] == nil {
		t.Fatalf("request identity missing: %v", command)
	}
	if _, present := command["policy_id"]; present {
		t.Fatalf("spec write leaked a policy_id: %v", command)
	}
	if _, present := command["revision"]; present {
		t.Fatalf("spec write leaked a revision: %v", command)
	}
	if !reflect.DeepEqual(command["spec"], decodeSpec(t)) {
		t.Fatalf("spec not forwarded verbatim: %v", command["spec"])
	}
}

func TestNetworkPolicyV2RejectsMalformedSelectionsBeforeUpstream(t *testing.T) {
	base := `"expected_resource_version":7`
	spec := `"spec":{"schema_version":2,"default":"deny","rules":[]}`
	for index, body := range []string{
		`{"action":"allow_all","spec":{"schema_version":1,"action":"allow_all"},` + base + `}`,
		`{"action":"allow_all",` + spec + `,` + base + `}`,
		`{"spec":null,` + base + `}`,
		`{"action":null,` + base + `}`,
		`{` + spec + `,"spec":{"schema_version":2,"default":"deny","rules":[]},` + base + `}`,
		`{` + spec + `,` + base + `,"extra":1}`,
		`{"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["10.0.0.1/24"]}]},` + base + `}`,
		`{"spec":{"schema_version":2,"default":"deny","rules":[],"action":"deny_all"},` + base + `}`,
		`{"spec":{"schema_version":3,"default":"deny","rules":[]},` + base + `}`,
		`{"spec":{"schema_version":2,"default":"permit","rules":[]},` + base + `}`,
		`{"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","protocol":""}]},` + base + `}`,
		`{"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[{"from":90,"to":80}]}]},` + base + `}`,
		`{"spec":{"schema_version":1,"action":"permit"},` + base + `}`,
		`{` + spec + `}`,
		`{` + spec + `,"expected_resource_version":0}`,
	} {
		backend := newBackendStub()
		response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodPut, networkPath, body)
		if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("malformed selection %d: %d %s calls=%d", index, response.Code, response.Body.String(), len(backend.calls))
		}
	}
}

func TestNetworkPolicyV2RejectsForeignPrincipalBeforeUpstream(t *testing.T) {
	backend := newBackendStub()
	request := networkRequest(http.MethodPut, networkPath, `{"spec":{"schema_version":2,"default":"deny","rules":[]},"expected_resource_version":7}`, "org-1")
	request.Header.Set("X-Antnest-Expected-Principal", url.PathEscape(`["other-org","user-admin"]`))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, request)
	if response.Code != http.StatusConflict || len(backend.calls) != 0 {
		t.Fatalf("foreign principal spec write=%d calls=%d", response.Code, len(backend.calls))
	}
}

func TestNetworkPolicyV2RejectsMismatchedDerivedAck(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"agent_id":"agent-1","policy_id":"custom/`+strings.Repeat("f", 64)+`","revision":1,"resource_version":8}`)
	response := requestNetworkAdmin(
		t, newTestHandler(t, backend), http.MethodPut, networkPath,
		`{"spec":`+networkPolicyV2Spec+`,"expected_resource_version":7}`,
	)
	if response.Code != 502 {
		t.Fatalf("mismatched derived ack=%d %s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 1 {
		t.Fatalf("expected exactly one downstream call: %d", len(backend.calls))
	}
}

func TestNetworkPolicyV1SpecWriteAndReadProjectLegacyAction(t *testing.T) {
	v1 := `{"schema_version":1,"action":"deny_all"}`
	canonical := `["org-1","agent-1",` + v1 + `]`
	sum := sha256.Sum256([]byte(canonical))
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"agent_id":"agent-1","policy_id":"custom/`+hex.EncodeToString(sum[:])+`","revision":1,"resource_version":8}`)
	response := requestNetworkAdmin(
		t, newTestHandler(t, backend), http.MethodPut, networkPath,
		`{"spec":`+v1+`,"expected_resource_version":7}`,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("v1 spec write=%d %s", response.Code, response.Body.String())
	}
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	if value["action"] != "deny_all" || value["resource_version"] != float64(8) || value["spec"] != nil {
		t.Fatalf("v1 ack must project action only: %v", value)
	}
	call := backend.singleCall(t)
	var command map[string]any
	decodeBytes(t, call.Body, &command)
	if _, present := command["policy_id"]; present || !reflect.DeepEqual(command["spec"], map[string]any{"schema_version": float64(1), "action": "deny_all"}) {
		t.Fatalf("v1 spec write must stay spec-only: %v", command)
	}
	backend = newBackendStub()
	backend.enqueue(http.StatusOK, strings.Replace(networkPolicyV2ViewFixture(), networkPolicyV2Spec, v1, 1))
	response = requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodGet, networkPath, "")
	if response.Code != http.StatusOK {
		t.Fatalf("v1 custom read=%d %s", response.Code, response.Body.String())
	}
	decodeBytes(t, response.Body.Bytes(), &value)
	if value["action"] != "deny_all" || value["resource_version"] != float64(7) || value["spec"] != nil {
		t.Fatalf("v1 read must project action: %v", value)
	}
}

func TestNetworkPolicyV2PreservesRangeEqualAndLegacyBytes(t *testing.T) {
	for _, document := range []string{
		`{"schema_version":1,"action":"deny_all"}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[443]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[{"from":443,"to":443}]}]}`,
	} {
		var spec networkPolicySpec
		if err := json.Unmarshal([]byte(document), &spec); err != nil {
			t.Fatalf("valid spec rejected: %s %v", document, err)
		}
		encoded, err := json.Marshal(spec)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != document {
			t.Fatalf("canonical bytes drifted: %s -> %s", document, encoded)
		}
	}
}
