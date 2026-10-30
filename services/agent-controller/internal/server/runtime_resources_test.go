package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const templateResourceBody = `{
	"request_id":"request-1",
	"organization_id":"org-1",
	"template_key":"key-1",
	"name":"agent",
	"model_profile_id":"model-1",
	"system_prompt":"You are helpful.",
	"max_model_requests":32,
	"context_policy_version":"context-v1",
	"runtime":{
		"image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"resources":{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864%s}
	}
}`

func resourceServer(t *testing.T) (http.Handler, *catalogServiceStub) {
	t.Helper()
	service := &catalogServiceStub{}
	handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{},
		func(ctx context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	return handler, service
}

func post(t *testing.T, handler http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	return response
}

func TestCreateTemplateForwardsOptionalRuntimeResources(t *testing.T) {
	handler, service := resourceServer(t)
	response := post(t, handler, "/internal/agent-templates",
		fmt.Sprintf(templateResourceBody, `,"cpu_millis":2500,"workspace_bytes":67108864`))
	if response.Code != http.StatusCreated {
		t.Fatalf("explicit limits rejected: %d %s", response.Code, response.Body.String())
	}
	resources := service.createTemplateInput.Runtime.Resources
	if resources.CPUMillis == nil || *resources.CPUMillis != 2500 ||
		resources.WorkspaceBytes == nil || *resources.WorkspaceBytes != 67108864 {
		t.Fatalf("optional limits not forwarded to the catalog: %+v", resources)
	}
}

const reviseResourceBody = `{
	"request_id":"request-1",
	"organization_id":"org-1",
	"name":"agent",
	"model_profile_id":"model-1",
	"system_prompt":"You are helpful.",
	"max_model_requests":32,
	"context_policy_version":"context-v1",
	"runtime":{
		"image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"resources":{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864%s}
	}
}`

func TestReviseTemplateForwardsOptionalRuntimeResources(t *testing.T) {
	handler, _ := resourceServer(t)
	response := post(t, handler, "/internal/agent-templates/template-1/revisions",
		fmt.Sprintf(reviseResourceBody, `,"cpu_millis":16000,"workspace_bytes":1099511627776`))
	if response.Code != http.StatusCreated {
		t.Fatalf("explicit limits rejected on revise: %d %s", response.Code, response.Body.String())
	}
}

func TestTemplateRuntimeResourceBoundariesRejectAtHTTP400(t *testing.T) {
	for _, test := range []struct {
		name   string
		path   string
		suffix string
	}{
		{"create_resources_null", "/internal/agent-templates", ``},
		{"create_cpu_null", "/internal/agent-templates", `,"cpu_millis":null`},
		{"create_unknown", "/internal/agent-templates", `,"bogus_limit":1`},
		{"create_cpu_fraction", "/internal/agent-templates", `,"cpu_millis":1.5`},
		{"revise_cpu_null", "/internal/agent-templates/template-1/revisions", `,"cpu_millis":null`},
		{"revise_unknown", "/internal/agent-templates/template-1/revisions", `,"bogus_limit":1`},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler, service := resourceServer(t)
			body := fmt.Sprintf(templateResourceBody, test.suffix)
			if strings.HasPrefix(test.name, "revise_") {
				body = fmt.Sprintf(reviseResourceBody, test.suffix)
			}
			if test.name == "create_resources_null" {
				body = `{
					"request_id":"request-1","organization_id":"org-1","template_key":"key-1",
					"name":"agent","model_profile_id":"model-1","system_prompt":"You are helpful.",
					"max_model_requests":32,"context_policy_version":"context-v1",
					"runtime":{"image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resources":null}
				}`
			}
			response := post(t, handler, test.path, body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("%s status=%d body=%s", test.name, response.Code, response.Body.String())
			}
			if service.createTemplateInput.RequestID != "" {
				t.Fatalf("%s reached the catalog", test.name)
			}
		})
	}
}

func TestCreateTemplateAcceptsLegacyResources(t *testing.T) {
	handler, service := resourceServer(t)
	response := post(t, handler, "/internal/agent-templates",
		fmt.Sprintf(templateResourceBody, ""))
	if response.Code != http.StatusCreated {
		t.Fatalf("legacy body rejected: %d %s", response.Code, response.Body.String())
	}
	resources := service.createTemplateInput.Runtime.Resources
	if resources.CPUMillis != nil || resources.WorkspaceBytes != nil {
		t.Fatalf("omission must arrive as nil, not concrete defaults: %+v", resources)
	}
}
