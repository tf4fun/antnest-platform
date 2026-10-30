package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestModelProfileUsageReadIsScopedAndComplete(t *testing.T) {
	service := &catalogServiceStub{usage: ports.ModelProfileUsage{Templates: 4, Agents: 9}}
	handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/model-profiles/model-1/usage?organization_id=org-1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("usage read must not be cached")
	}
	var usage ports.ModelProfileUsage
	if err := json.Unmarshal(response.Body.Bytes(), &usage); err != nil {
		t.Fatal(err)
	}
	if usage.Templates != 4 || usage.Agents != 9 || service.usageOrganizationID != "org-1" || service.usageModelProfileID != "model-1" {
		t.Fatalf("usage response drifted: %+v scope=%q/%q", usage, service.usageOrganizationID, service.usageModelProfileID)
	}
	service.usageErr = ports.ErrNotFound
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/model-profiles/foreign/usage?organization_id=org-1", nil))
	if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "model-1") {
		t.Fatalf("unknown or cross-organization usage must fail closed: %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{
		"/internal/model-profiles/model-1/usage",
		"/internal/model-profiles/model-1/usage?organization_id=org-1&extra=1",
		"/internal/model-profiles/model-1/usage?organization_id=org-1&organization_id=org-1",
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d", path, response.Code)
		}
	}
}

func TestModelProfileEventsReadPaginatesAndValidatesStrictly(t *testing.T) {
	next := int64(3)
	service := &catalogServiceStub{eventPage: ports.ModelProfileEventPage{
		Items: []ports.ModelProfileRevisedEvent{{
			EventType: ports.EventModelProfileRevised, RequestID: "request-1",
			OrganizationID: "org-1", ModelProfileID: "model-1", RevisionID: "revision-2",
			PreviousRevision: 1, Revision: 2, OccurredAt: time.Unix(10, 0).UTC(),
		}},
		NextAfterRevision: &next,
	}}
	handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/model-profiles/model-1/events?organization_id=org-1", nil))
	if response.Code != http.StatusOK || service.eventLimit != 0 || service.eventAfterRevision != 0 {
		t.Fatalf("status=%d body=%s scope=%+v", response.Code, response.Body.String(), service)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("event read must not be cached")
	}
	var page modelProfileEventListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Revision != 2 || page.NextAfterRevision == nil || *page.NextAfterRevision != 3 {
		t.Fatalf("event page drifted: %+v", page)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/model-profiles/model-1/events?organization_id=org-1&after_revision=4&limit=10", nil))
	if response.Code != http.StatusOK || service.eventAfterRevision != 4 || service.eventLimit != 10 {
		t.Fatalf("pagination not forwarded: status=%d scope=%+v", response.Code, service)
	}
	service.eventErr = ports.ErrNotFound
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/model-profiles/missing/events?organization_id=org-1", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("unknown or cross-organization events must fail closed: %d", response.Code)
	}
	service.eventErr = nil
	for _, query := range []string{
		"after_revision=-1", "after_revision=1.5", "after_revision=text",
		"limit=0", "limit=101", "limit=text", "unknown=1",
		"organization_id=org-1&after_revision=1&after_revision=2",
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/model-profiles/model-1/events?"+query+"&organization_id=org-1", nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: status=%d", query, response.Code)
		}
	}
}

func TestModelProfileInspectionRejectsRequestBodies(t *testing.T) {
	for _, path := range []string{
		"/internal/model-profiles/model-1/usage?organization_id=org-1",
		"/internal/model-profiles/model-1/events?organization_id=org-1",
	} {
		service := &catalogServiceStub{}
		handler, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(
			http.MethodGet, path, strings.NewReader(`{"unexpected":true}`)))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s body-bearing request: status=%d", path, response.Code)
		}
		if service.usageOrganizationID != "" || service.eventOrganizationID != "" {
			t.Fatalf("%s body-bearing request reached the catalog service", path)
		}
	}
}

func TestModelProfileInspectionDeniesUnverifiedAndForeignScope(t *testing.T) {
	for _, path := range []string{
		"/internal/model-profiles/model-1/usage?organization_id=org-1",
		"/internal/model-profiles/model-1/events?organization_id=org-1",
	} {
		service := &catalogServiceStub{}
		boundary, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		f := boundary.(*businessFixture)
		raw := httptest.NewRecorder()
		f.raw.ServeHTTP(raw, httptest.NewRequest(http.MethodGet, path, nil))
		if raw.Code != http.StatusUnauthorized || service.usageOrganizationID != "" || service.eventOrganizationID != "" {
			t.Fatalf("%s unauthenticated request reached business: %d", path, raw.Code)
		}
		foreign := httptest.NewRequest(http.MethodGet, path, nil)
		foreign.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
		foreign.Header.Set(callercontext.Header, f.sign(map[string]any{"org": "org-2"}))
		response := httptest.NewRecorder()
		f.raw.ServeHTTP(response, foreign)
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s forged scope: %d %s", path, response.Code, response.Body.String())
		}
		member := httptest.NewRequest(http.MethodGet, path, nil)
		member.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
		member.Header.Set(callercontext.Header, f.sign(map[string]any{"org_role": "member"}))
		response = httptest.NewRecorder()
		f.raw.ServeHTTP(response, member)
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s non-administrator: %d", path, response.Code)
		}
		if service.usageOrganizationID != "" || service.eventOrganizationID != "" {
			t.Fatalf("%s denied scope reached the catalog service", path)
		}
	}
}
