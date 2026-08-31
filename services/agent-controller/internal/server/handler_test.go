package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCatalogHandlerCreatesModelProfileWithoutEchoingSecret(t *testing.T) {
	t.Parallel()

	service := &catalogServiceStub{modelView: sampleModelProfileView()}
	handler, err := NewHandler(service, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	body := `{
        "request_id":"request-1",
        "organization_id":"org-1",
        "profile_key":"deepseek",
        "display_name":"DeepSeek",
        "model":{
          "base_url":"https://api.example.com/v1",
          "model":"deepseek-chat",
          "context_window":128000,
          "max_output_tokens":8192,
          "supports_images":false
        },
        "credential":{"secret_type":"bearer","secret":"top-secret"}
      }`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/model-profiles", strings.NewReader(body))
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if service.createModelInput.CredentialSecret != "top-secret" {
		t.Fatal("credential was not delivered to Catalog service")
	}
	if bytes.Contains(response.Body.Bytes(), []byte("top-secret")) || bytes.Contains(response.Body.Bytes(), []byte("ciphertext")) {
		t.Fatalf("response leaked credential material: %s", response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["model_profile_id"] != "model-1" || payload["revision_id"] != "model-revision-1" {
		t.Fatalf("response does not match control contract: %v", payload)
	}
}

func TestCatalogHandlerRejectsUnknownFieldsAndTrailingJSON(t *testing.T) {
	t.Parallel()

	service := &catalogServiceStub{}
	handler, err := NewHandler(service, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	requests := []string{
		`{"request_id":"request-1","unknown":true}`,
		`{"request_id":"request-1"}{"request_id":"request-2"}`,
	}
	for _, body := range requests {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/internal/model-profiles", strings.NewReader(body))
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Errorf("body %q status = %d response=%s", body, response.Code, response.Body.String())
		}
	}
	if service.createModelCalls != 0 {
		t.Fatalf("invalid requests reached Catalog service %d times", service.createModelCalls)
	}
}

func TestCatalogHandlerListsCurrentTemplatesWithNullableCursor(t *testing.T) {
	t.Parallel()

	service := &catalogServiceStub{templatePage: application.TemplatePage{
		Items: []application.TemplateView{sampleTemplateView()}, NextAfterID: "template-1",
	}}
	handler, err := NewHandler(service, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/agent-templates?organization_id=org-1&after_id=template-0&limit=20", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if service.listInput != (application.ListCatalogInput{OrganizationID: "org-1", AfterID: "template-0", Limit: 20}) {
		t.Fatalf("list input = %+v", service.listInput)
	}
	var payload struct {
		Items       []map[string]any `json:"items"`
		NextAfterID *string          `json:"next_after_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Items) != 1 || payload.NextAfterID == nil || *payload.NextAfterID != "template-1" {
		t.Fatalf("unexpected Template page: %+v", payload)
	}
	skillRefs, ok := payload.Items[0]["skill_refs"].([]any)
	if !ok || len(skillRefs) != 0 {
		t.Fatalf("Stage 2 Template skill refs = %#v", payload.Items[0]["skill_refs"])
	}
}

func TestCatalogHandlerMapsStableErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "invalid", err: application.ErrInvalidInput, status: http.StatusBadRequest, code: "invalid_request"},
		{name: "not found", err: ports.ErrNotFound, status: http.StatusNotFound, code: "reference_not_found"},
		{name: "disabled", err: ports.ErrDisabledReference, status: http.StatusConflict, code: "reference_disabled"},
		{name: "request conflict", err: ports.ErrRequestConflict, status: http.StatusConflict, code: "request_id_conflict"},
		{name: "concurrent", err: ports.ErrConcurrentChange, status: http.StatusConflict, code: "lifecycle_conflict"},
		{name: "internal", err: errors.New("database detail"), status: http.StatusInternalServerError, code: "internal_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &catalogServiceStub{getModelErr: test.err}
			handler, err := NewHandler(service, func(context.Context) error { return nil })
			if err != nil {
				t.Fatalf("new handler: %v", err)
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/internal/model-profiles/model-1", nil)
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
			var payload errorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if payload.Code != test.code || strings.Contains(payload.Message, "database detail") {
				t.Fatalf("error response = %+v", payload)
			}
		})
	}
}

type catalogServiceStub struct {
	createModelInput application.CreateModelProfileInput
	createModelCalls int
	modelView        application.ModelProfileView
	getModelErr      error
	templatePage     application.TemplatePage
	listInput        application.ListCatalogInput
}

func (service *catalogServiceStub) CreateModelProfile(
	_ context.Context, input application.CreateModelProfileInput,
) (application.ModelProfileView, error) {
	service.createModelCalls++
	service.createModelInput = input
	return service.modelView, nil
}

func (service *catalogServiceStub) ReviseModelProfile(
	context.Context, application.ReviseModelProfileInput,
) (application.ModelProfileView, error) {
	return service.modelView, nil
}

func (service *catalogServiceStub) GetModelProfile(
	context.Context, string,
) (application.ModelProfileView, error) {
	return service.modelView, service.getModelErr
}

func (service *catalogServiceStub) ListModelProfiles(
	context.Context, application.ListCatalogInput,
) (application.ModelProfilePage, error) {
	return application.ModelProfilePage{}, nil
}

func (service *catalogServiceStub) CreateTemplate(
	context.Context, application.CreateTemplateInput,
) (application.TemplateView, error) {
	return sampleTemplateView(), nil
}

func (service *catalogServiceStub) ReviseTemplate(
	context.Context, application.ReviseTemplateInput,
) (application.TemplateView, error) {
	return sampleTemplateView(), nil
}

func (service *catalogServiceStub) GetTemplate(
	context.Context, string,
) (application.TemplateView, error) {
	return sampleTemplateView(), nil
}

func (service *catalogServiceStub) ListTemplates(
	_ context.Context, input application.ListCatalogInput,
) (application.TemplatePage, error) {
	service.listInput = input
	return service.templatePage, nil
}

func sampleModelProfileView() application.ModelProfileView {
	return application.ModelProfileView{
		ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", RevisionID: "model-revision-1", Revision: 1,
		CredentialRef: "credential-1", CredentialVersion: "credential-version-1", Enabled: true,
		Model: domain.ModelSpec{
			BaseURL: "https://api.example.com/v1", Model: "deepseek-chat",
			ContextWindow: 128000, MaxOutputTokens: 8192,
		},
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
}

func sampleTemplateView() application.TemplateView {
	return application.TemplateView{
		TemplateID: "template-1", OrganizationID: "org-1", TemplateKey: "personal",
		Name: "Personal", Revision: 1, ModelProfileRevisionID: "model-revision-1",
		SystemPrompt: "You are helpful.", MaxModelRequests: 16,
		ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: domain.RuntimeSpecInput{
			ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Resources: domain.RuntimeResources{
				MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
			},
		},
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
}
