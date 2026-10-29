package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const templatePolicyBody = `{"name":"t","model_profile_id":"profile-1","model_retry":{"max":0,"base_ms":1,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":0,"max_cost_usd_micros":0}}`

func templateRequest(method, path, body string) *http.Request {
	request := scopedLifecycleRequest(method, path, body, "org-1")
	request.Header.Set("Idempotency-Key", "template-policy-1")
	return request
}

func templateUpstreamFixture(extra string) string {
	return `{"template_id":"tpl-1","name":"t","revision":1,"organization_id":"org-1","model_profile_id":"profile-1","system_prompt":"","max_model_requests":32,"context_policy_version":"context-v1","runtime":{"image_ref":"img","resources":{}},"skill_refs":[],"enabled":true,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"` + extra + `}`
}

func TestTemplateModelPolicyCreateForwardsOptionalFields(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, templateUpstreamFixture(`,"model_retry":{"max":0,"base_ms":1,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":0,"max_cost_usd_micros":0}`))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodPost, "/api/admin/templates", templatePolicyBody))
	if response.Code != http.StatusOK || len(backend.calls) != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body.String())
	}
	var sent, got map[string]any
	decodeBytes(t, backend.calls[0].Body, &sent)
	for _, name := range []string{"model_retry", "failover", "run_budget"} {
		if _, ok := sent[name]; !ok {
			t.Fatalf("payload missing %s: %v", name, sent)
		}
	}
	if sent["failover"] != "never" {
		t.Fatalf("failover=%v", sent["failover"])
	}
	decodeBytes(t, response.Body.Bytes(), &got)
	if got["failover"] != "never" || got["model_retry"] == nil || got["run_budget"] == nil {
		t.Fatalf("projection lost policy: %v", got)
	}
}

func TestTemplateModelPolicyReviseForwardsOptionalFields(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, templateUpstreamFixture(`,"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"before_output"`))
	body := `{"name":"t","model_profile_id":"profile-1","max_model_requests":16,"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"before_output"}`
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodPost, "/api/admin/templates/tpl-1/revisions", body))
	if response.Code != http.StatusOK || len(backend.calls) != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body.String())
	}
	var sent map[string]any
	decodeBytes(t, backend.calls[0].Body, &sent)
	if _, ok := sent["model_retry"]; !ok || sent["failover"] != "before_output" {
		t.Fatalf("forwarded=%v", sent)
	}
	if _, forwarded := sent["run_budget"]; forwarded {
		t.Fatalf("omitted run_budget must not be forwarded: %v", sent)
	}
}

func TestTemplateModelPolicyOmittedFieldsStayOmitted(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, templateUpstreamFixture(""))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodPost, "/api/admin/templates",
		`{"name":"t","model_profile_id":"profile-1","fallback_model_profile_ids":null,"skill_refs":null,"runtime":null}`))
	if response.Code != http.StatusOK || len(backend.calls) != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body.String())
	}
	var sent, got map[string]any
	decodeBytes(t, backend.calls[0].Body, &sent)
	for _, name := range []string{"model_retry", "failover", "run_budget"} {
		if _, ok := sent[name]; ok {
			t.Fatalf("omitted field %s was forwarded: %v", name, sent)
		}
	}
	decodeBytes(t, response.Body.Bytes(), &got)
	for _, name := range []string{"model_retry", "failover", "run_budget"} {
		if _, ok := got[name]; ok {
			t.Fatalf("absent upstream field %s was invented: %v", name, got)
		}
	}
}

func TestTemplateModelPolicyReadHistoryAndListPreserveFields(t *testing.T) {
	extra := `,"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":1000}`
	for _, path := range []string{
		"/api/admin/templates/tpl-1",
		"/api/admin/templates/tpl-1/revisions/1",
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, templateUpstreamFixture(extra))
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodGet, path, ""))
		if response.Code != http.StatusOK {
			t.Fatalf("path=%s status=%d body=%s", path, response.Code, response.Body.String())
		}
		var got map[string]any
		decodeBytes(t, response.Body.Bytes(), &got)
		if got["failover"] != "never" || got["model_retry"] == nil || got["run_budget"] == nil {
			t.Fatalf("path=%s projection=%v", path, got)
		}
	}
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"items":[`+templateUpstreamFixture(extra)+`],"next_after_id":null}`)
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodGet, "/api/admin/templates", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	decodeBytes(t, response.Body.Bytes(), &list)
	if len(list.Items) != 1 || list.Items[0]["failover"] != "never" {
		t.Fatalf("list=%v", list.Items)
	}
}

func TestTemplateModelPolicyRejectsMalformedFields(t *testing.T) {
	for _, fragment := range []string{
		`"model_retry":null`, `"failover":null`, `"run_budget":null`,
		`"model_retry":{"max":9,"base_ms":1,"cap_ms":10}`,
		`"model_retry":{"max":1,"base_ms":0,"cap_ms":10}`,
		`"model_retry":{"max":1,"base_ms":200,"cap_ms":199}`,
		`"model_retry":{"max":1,"base_ms":200,"cap_ms":30001}`,
		`"model_retry":{"max":1,"base_ms":200}`,
		`"model_retry":{"max":1,"base_ms":200,"cap_ms":300,"bogus":1}`,
		`"failover":"sometimes"`,
		`"run_budget":{"max_input_tokens":null}`,
		`"run_budget":{"max_input_tokens":-1}`,
		`"run_budget":{"max_input_tokens":9007199254740992}`,
		`"run_budget":{"bogus":1}`,
		`"Model_Retry":{"max":1,"base_ms":1,"cap_ms":1}`,
	} {
		backend := newBackendStub()
		body := `{"name":"t","model_profile_id":"profile-1",` + fragment + `}`
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodPost, "/api/admin/templates", body))
		if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("fragment=%s status=%d calls=%d body=%s", fragment, response.Code, len(backend.calls), response.Body.String())
		}
	}
}

func TestTemplateModelPolicyProjectionRejectsMalformedUpstream(t *testing.T) {
	for _, extra := range []string{
		`,"model_retry":null`,
		`,"model_retry":{"max":9,"base_ms":1,"cap_ms":10}`,
		`,"failover":"sometimes"`,
		`,"run_budget":{"max_input_tokens":-1}`,
		`,"run_budget":{"soft_unknown":3}`,
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, templateUpstreamFixture(extra))
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, templateRequest(http.MethodGet, "/api/admin/templates/tpl-1", ""))
		if response.Code != http.StatusBadGateway {
			t.Fatalf("extra=%s status=%d body=%s", extra, response.Code, response.Body.String())
		}
	}
}
