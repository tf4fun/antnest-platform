package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const resourceCreateBody = `{
	"name":"Personal Agent","model_profile_id":"model-1",
	"system_prompt":"You are helpful.","max_model_requests":32,
	"runtime":{"image_ref":"antnest/antnest-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"resources":{"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456%s}}
}`

const resourceReviseBody = `{
	"name":"Personal Agent","model_profile_id":"model-1",
	"system_prompt":"Revised instructions.","max_model_requests":32,
	"runtime":{"image_ref":"antnest/antnest-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"resources":{"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456%s}}
}`

func resourceBody(template, suffix string) string {
	return strings.Replace(template, "%s", suffix, 1)
}

func forwardedResources(t *testing.T, backend *backendStub, index int) map[string]any {
	t.Helper()
	var payload map[string]any
	decodeBytes(t, backend.calls[index].Body, &payload)
	runtime, _ := payload["runtime"].(map[string]any)
	resources, _ := runtime["resources"].(map[string]any)
	if resources == nil {
		t.Fatalf("runtime.resources missing from forwarded body: %v", payload)
	}
	return resources
}

func TestCreateTemplateForwardsRuntimeResourceLimits(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":1}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/templates",
		resourceBody(resourceCreateBody, `,"cpu_millis":2500,"workspace_bytes":67108864`))
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if backend.calls[0].Path != "/internal/agent-templates" {
		t.Fatalf("upstream path=%s", backend.calls[0].Path)
	}
	resources := forwardedResources(t, backend, 0)
	if resources["cpu_millis"] != float64(2500) || resources["workspace_bytes"] != float64(67108864) {
		t.Fatalf("resource limits not forwarded exactly: %v", resources)
	}
}

func TestReviseTemplateForwardsRuntimeResourceLimits(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":2}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/templates/template-1/revisions",
		resourceBody(resourceReviseBody, `,"cpu_millis":2500,"workspace_bytes":67108864`))
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.calls[0]
	if call.Path != "/internal/agent-templates/template-1/revisions" {
		t.Fatalf("upstream path=%s", call.Path)
	}
	resources := forwardedResources(t, backend, 0)
	if resources["cpu_millis"] != float64(2500) || resources["workspace_bytes"] != float64(67108864) {
		t.Fatalf("revision dropped the resource limits: %v", resources)
	}
}

func TestRuntimeResourceContractBoundsAccepted(t *testing.T) {
	for _, test := range []struct {
		name   string
		suffix string
	}{
		{"minimum", `,"cpu_millis":100,"workspace_bytes":67108864`},
		{"maximum", `,"cpu_millis":16000,"workspace_bytes":1099511627776`},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":1}`)
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodPost, "/api/admin/templates",
				resourceBody(resourceCreateBody, test.suffix))
			if response.Code != http.StatusCreated {
				t.Fatalf("%s boundary rejected: %d %s", test.name, response.Code, response.Body.String())
			}
		})
	}
}

func TestRuntimeResourceInvalidRejectedBeforeBackend(t *testing.T) {
	for _, test := range []struct {
		name   string
		path   string
		suffix string
	}{
		{"create_cpu_zero", "/api/admin/templates", `,"cpu_millis":0`},
		{"create_workspace_zero", "/api/admin/templates", `,"workspace_bytes":0`},
		{"create_cpu_null", "/api/admin/templates", `,"cpu_millis":null`},
		{"create_workspace_null", "/api/admin/templates", `,"workspace_bytes":null`},
		{"create_cpu_below", "/api/admin/templates", `,"cpu_millis":99`},
		{"create_cpu_above", "/api/admin/templates", `,"cpu_millis":16001`},
		{"create_workspace_below", "/api/admin/templates", `,"workspace_bytes":67108863`},
		{"create_workspace_above", "/api/admin/templates", `,"workspace_bytes":1099511627777`},
		{"create_cpu_fraction", "/api/admin/templates", `,"cpu_millis":1.5`},
		{"revise_cpu_zero", "/api/admin/templates/template-1/revisions", `,"cpu_millis":0`},
		{"revise_workspace_zero", "/api/admin/templates/template-1/revisions", `,"workspace_bytes":0`},
		{"revise_cpu_null", "/api/admin/templates/template-1/revisions", `,"cpu_millis":null`},
		{"revise_workspace_null", "/api/admin/templates/template-1/revisions", `,"workspace_bytes":null`},
		{"revise_cpu_below", "/api/admin/templates/template-1/revisions", `,"cpu_millis":99`},
		{"revise_cpu_above", "/api/admin/templates/template-1/revisions", `,"cpu_millis":16001`},
		{"revise_workspace_below", "/api/admin/templates/template-1/revisions", `,"workspace_bytes":67108863`},
		{"revise_workspace_above", "/api/admin/templates/template-1/revisions", `,"workspace_bytes":1099511627777`},
		{"revise_cpu_fraction", "/api/admin/templates/template-1/revisions", `,"cpu_millis":1.5`},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":2}`)
			handler := newTestHandler(t, backend)
			template := resourceCreateBody
			if strings.HasPrefix(test.name, "revise_") {
				template = resourceReviseBody
			}
			response := requestAdmin(t, handler, http.MethodPost, test.path,
				resourceBody(template, test.suffix))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("%s status=%d body=%s", test.name, response.Code, response.Body.String())
			}
			if len(backend.calls) != 0 {
				t.Fatalf("%s reached the backend %d times", test.name, len(backend.calls))
			}
		})
	}
}

func TestTemplateProjectionsPreserveRuntimeResourceLimits(t *testing.T) {
	templatePayload := `{"template_id":"template-1","organization_id":"org-1","template_key":"personal",
		"name":"Personal","revision":1,"model_profile_id":"model-1","system_prompt":"x",
		"max_model_requests":8,"context_policy_version":"context-v1",
		"runtime":{"image_ref":"` + testRuntimeDigest + `","resources":{
			"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456,
			"cpu_millis":2500,"workspace_bytes":67108864}}}`
	for _, test := range []struct {
		name      string
		projector func([]byte) ([]byte, error)
		payload   string
	}{
		{"detail", projectTemplate, templatePayload},
		{"list", projectTemplateList, `{"items":[` + templatePayload + `],"next_after_id":null}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := test.projector([]byte(test.payload))
			if err != nil {
				t.Fatal(err)
			}
			encoded := string(result)
			if !strings.Contains(encoded, `"cpu_millis":2500`) ||
				!strings.Contains(encoded, `"workspace_bytes":67108864`) {
				t.Fatalf("%s projection dropped the resource limits: %s", test.name, encoded)
			}
		})
	}
}

func TestAgentProjectionPreservesRuntimeResourceLimits(t *testing.T) {
	payload := `{"agent_id":"a1","lifecycle_state":"provisioned","activation_state":"enabled",
		"configuration":{"model_profile":{"model_profile_id":"model-1"},
		"runtime":{"image_ref":"` + testRuntimeDigest + `","resources":{
			"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456,
			"cpu_millis":2500,"workspace_bytes":67108864}}}}`
	for _, test := range []struct {
		name      string
		projector func([]byte) ([]byte, error)
		payload   string
	}{
		{"detail", projectAgent, payload},
		{"list", projectAgentList, `{"items":[` + payload + `],"next_after_id":null}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := test.projector([]byte(test.payload))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(result), `"cpu_millis":2500`) ||
				!strings.Contains(string(result), `"workspace_bytes":67108864`) {
				t.Fatalf("%s projection dropped the resource limits: %s", test.name, result)
			}
		})
	}
}

func TestProjectionsKeepLegacyResourceFieldsAbsent(t *testing.T) {
	templatePayload := `{"template_id":"template-1","organization_id":"org-1","template_key":"personal",
		"name":"Personal","revision":1,"model_profile_id":"model-1","system_prompt":"x",
		"max_model_requests":8,"context_policy_version":"context-v1",
		"runtime":{"image_ref":"` + testRuntimeDigest + `","resources":{
			"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456}}}`
	result, err := projectTemplate([]byte(templatePayload))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(result), "cpu_millis") || strings.Contains(string(result), "workspace_bytes") {
		t.Fatalf("legacy resources must stay absent in the projection: %s", result)
	}
}

func TestReviseFromProjectedTemplatePreservesResources(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"template_id":"template-1","organization_id":"org-1","revision":1,
		"name":"Personal","model_profile_id":"model-1","system_prompt":"x","max_model_requests":8,
		"context_policy_version":"context-v1",
		"runtime":{"image_ref":"`+testRuntimeDigest+`","resources":{
			"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456,
			"cpu_millis":2500,"workspace_bytes":67108864}}}`)
	backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":2}`)
	handler := newTestHandler(t, backend)

	detail := requestAdmin(t, handler, http.MethodGet, "/api/admin/templates/template-1", "")
	if detail.Code != http.StatusOK {
		t.Fatalf("detail status=%d", detail.Code)
	}
	var projected map[string]any
	decodeBytes(t, detail.Body.Bytes(), &projected)
	runtime, _ := projected["runtime"].(map[string]any)
	resources, _ := runtime["resources"].(map[string]any)
	if resources["cpu_millis"] != float64(2500) {
		t.Fatalf("projected detail lost cpu_millis: %v", resources)
	}

	runtimeJSON, err := json.Marshal(runtime)
	if err != nil {
		t.Fatal(err)
	}
	revision := `{"name":"Personal","model_profile_id":"model-1","system_prompt":"x",
		"max_model_requests":8,"runtime":` + string(runtimeJSON) + `}`
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/templates/template-1/revisions", revision)
	if response.Code != http.StatusCreated {
		t.Fatalf("revise status=%d body=%s", response.Code, response.Body.String())
	}
	forwarded := forwardedResources(t, backend, 1)
	if forwarded["cpu_millis"] != float64(2500) || forwarded["workspace_bytes"] != float64(67108864) {
		t.Fatalf("revision built from the projected template dropped limits: %v", forwarded)
	}
}
