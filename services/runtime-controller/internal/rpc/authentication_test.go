package rpc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
)

func TestEveryControlRouteRejectsMissingCredentialBeforeEffects(t *testing.T) {
	var contract machineContract
	readJSONFile(t, filepath.Join(serviceRoot(t), "api/control-contract.json"), &contract)
	for _, route := range contract.Routes {
		if route.Path == "/status" {
			continue
		}
		t.Run(route.OperationID, func(t *testing.T) {
			service, preparation := &fakeService{}, &preparationStub{}
			handler, err := NewHandler(service, observation.NewHub(), time.Millisecond, time.Second, fixtureSecurity(), preparation)
			if err != nil {
				t.Fatal(err)
			}
			path := strings.NewReplacer("{agent_id}", "agent-1", "{request_id}", "request-1").Replace(route.Path)
			request := httptest.NewRequest(route.Method, path, strings.NewReader("{}"))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "request-1")
			request.Header.Set("X-Antnest-Principal-ID", "pretend-controller")
			ctx, cancel := context.WithTimeout(request.Context(), 5*time.Millisecond)
			defer cancel()
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request.WithContext(ctx))
			if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "service_unauthenticated") {
				t.Fatalf("unauthenticated route admitted: %d %s", response.Code, response.Body.String())
			}
			if service.initializeCalls != 0 || service.agentID != "" || service.command != "" || preparation.released || preparation.received.OwnerOperationID != "" {
				t.Fatal("untrusted request reached business effects")
			}
		})
	}
}

func TestControlJSONRejectsMissingMediaTypeBeforeEffects(t *testing.T) {
	service := &fakeService{}
	handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Minute, fixtureSecurity())
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", strings.NewReader(`{"configuration":{}}`))
	request.Header.Set("Idempotency-Key", "request-1")
	request.Header.Set("Antnest-Service-Authorization", "Bearer AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType || service.initializeCalls != 0 {
		t.Fatalf("ambiguous JSON media reached business effects: %d %s", response.Code, response.Body.String())
	}
}

func TestWrongWorkloadCannotUseControllerOrSkillPreparationRoutes(t *testing.T) {
	var contract machineContract
	readJSONFile(t, filepath.Join(serviceRoot(t), "api/control-contract.json"), &contract)
	for _, route := range contract.Routes {
		if route.Path == "/status" {
			continue
		}
		t.Run(route.OperationID, func(t *testing.T) {
			service, preparation := &fakeService{}, &preparationStub{}
			handler, err := NewHandler(service, observation.NewHub(), time.Millisecond, time.Second, fixtureSecurity(), preparation)
			if err != nil {
				t.Fatal(err)
			}
			path := strings.NewReplacer("{agent_id}", "agent-1", "{request_id}", "request-1").Replace(route.Path)
			request := httptest.NewRequest(route.Method, path, strings.NewReader("{}"))
			request.Header.Set("Antnest-Service-Authorization", "Bearer "+strings.Repeat("A", 43))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "caller_not_allowed") || service.initializeCalls != 0 || preparation.released {
				t.Fatalf("non-Controller workload admitted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestEveryControlJSONRouteRejectsAmbiguousMediaAndMalformedJSON(t *testing.T) {
	var contract machineContract
	readJSONFile(t, filepath.Join(serviceRoot(t), "api/control-contract.json"), &contract)
	for _, route := range contract.Routes {
		if route.RequestBody == "" {
			continue
		}
		t.Run(route.OperationID, func(t *testing.T) {
			for _, media := range []string{"", "text/plain", "application/problem+json", "application/json; charset=latin1", "application/json; charset=\"\"", "application/json; extra=utf-8", "application/json, application/json"} {
				service, preparation := &fakeService{}, &preparationStub{}
				handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second, fixtureSecurity(), preparation)
				if err != nil {
					t.Fatal(err)
				}
				path := strings.NewReplacer("{agent_id}", "agent-1", "{request_id}", "request-1").Replace(route.Path)
				request := httptest.NewRequest(route.Method, path, strings.NewReader("{}"))
				request.Header.Set("Antnest-Service-Authorization", "Bearer "+controllerTestToken)
				if media != "" {
					request.Header.Set("Content-Type", media)
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != 415 || service.initializeCalls != 0 || preparation.released {
					t.Fatalf("media %q admitted: %d %s", media, response.Code, response.Body.String())
				}
			}
		})
	}
	for _, raw := range []string{`{"configuration":{},"configuration":{}}`, `{"configuration":{},"Configuration":{}}`, `{"configuration":{"image_ref":"x","Image_Ref":"y"}}`, "{\"configuration\":\"\xff\"}", "\ufeff{}", "{} {}", "[]", strings.Repeat(" ", maxRequestBytes+1)} {
		service := &fakeService{}
		handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second, fixtureSecurity())
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("POST", "/internal/runtimes/agent-1/initialize", strings.NewReader(raw))
		request.Header.Set("Antnest-Service-Authorization", "Bearer "+controllerTestToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "request-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 400 || service.initializeCalls != 0 {
			t.Fatal("malformed or aliased JSON admitted")
		}
	}
}

func TestReadinessIsLocalAndHealthListenerHasNoControlRoutes(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Second, fixtureSecurity())
	if err != nil {
		t.Fatal(err)
	}
	for _, boundary := range []http.Handler{handler, handler.HealthHandler()} {
		request := httptest.NewRequest("GET", "/status", nil)
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, request)
		if response.Code != 404 {
			t.Fatal("remote caller could read local readiness")
		}
		request = httptest.NewRequest("GET", "/status", nil)
		request.RemoteAddr = "127.0.0.1:12345"
		response = httptest.NewRecorder()
		boundary.ServeHTTP(response, request)
		if response.Code != 200 || !strings.Contains(response.Body.String(), "monitor_ready") {
			t.Fatal("local monitor readiness projection changed")
		}
	}
	request := httptest.NewRequest("GET", "/internal/runtimes", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Antnest-Service-Authorization", "Bearer "+controllerTestToken)
	response := httptest.NewRecorder()
	handler.HealthHandler().ServeHTTP(response, request)
	if response.Code != 404 {
		t.Fatal("health listener exposes control routes")
	}
}
