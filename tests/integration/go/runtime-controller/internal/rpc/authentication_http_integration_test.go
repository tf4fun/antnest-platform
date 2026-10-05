package rpc

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
)

func TestNativeHTTPControlAdmission(t *testing.T) {
	service, preparation := &fakeService{operation: deployment.Operation{State: deployment.OperationCompleted}}, &preparationStub{}
	handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second, fixtureSecurity(), preparation)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		finished <- struct{}{}
	}))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = time.Second
	t.Cleanup(client.CloseIdleConnections)
	request := func(method, path string, headers http.Header, body string, status int, code string) {
		t.Helper()
		req, err := http.NewRequestWithContext(context.Background(), method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header = headers.Clone()
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		<-finished // Synchronize with the real handler before inspecting effects.
		if err != nil || response.StatusCode != status || code != "" && !strings.Contains(string(raw), code) {
			t.Fatalf("%s %s: %d %s %v", method, path, response.StatusCode, raw, err)
		}
		if status == 401 && response.Header.Get("WWW-Authenticate") != `Bearer realm="antnest-service"` {
			t.Fatal("missing workload challenge")
		}
		if strings.Contains(string(raw), controllerTestToken) || response.Header.Get("Antnest-Caller-Context") != "" {
			t.Fatal("private authority leaked into response")
		}
	}
	var contract machineContract
	readJSONFile(t, filepath.Join(serviceRoot(t), "api/control-contract.json"), &contract)
	for _, route := range contract.Routes {
		if route.Path == "/status" {
			continue
		}
		path := strings.NewReplacer("{agent_id}", "agent-1", "{request_id}", "request-1").Replace(route.Path)
		for _, value := range []struct {
			header []string
			status int
			code   string
		}{
			{nil, 401, "service_unauthenticated"},
			{[]string{"Bearer " + strings.Repeat("A", 43)}, 403, "caller_not_allowed"},
			{[]string{"Bearer " + controllerTestToken, "Bearer " + controllerTestToken}, 401, "service_unauthenticated"},
		} {
			request(route.Method, path, http.Header{
				"Antnest-Service-Authorization": value.header,
				"Content-Type":                  {"application/json"},
				"X-Antnest-Principal-Id":        {"pretend-controller"},
				"Authorization":                 {"Bearer unrelated-user-token"},
			}, "{}", value.status, value.code)
		}
	}
	valid := http.Header{"Antnest-Service-Authorization": {"bEaReR " + controllerTestToken}}
	request("GET", "/internal/runtimes", valid, "", 200, "")
	for _, media := range [][]string{nil, {"text/plain"}, {"application/json", "application/json"}} {
		headers := valid.Clone()
		headers["Content-Type"] = media
		request("POST", "/internal/runtimes/agent-1/initialize", headers, "{}", 415, "unsupported_media_type")
	}
	valid.Set("Content-Type", "application/json; charset=utf-8")
	valid.Set("Idempotency-Key", "request-1")
	request("POST", "/internal/runtimes/agent-1/initialize", valid, `{"configuration":{},"Configuration":{}}`, 400, "invalid_request")
	if service.initializeCalls != 0 || service.agentID != "" || service.command != "" || preparation.released {
		t.Fatal("rejected HTTP request reached a lifecycle or Skill preparation effect")
	}
	request("POST", "/internal/runtimes/agent-1/initialize", valid, `{"configuration":{}}`, 200, "")
	if service.initializeCalls != 1 || service.agentID != "agent-1" {
		t.Fatal("verified Controller could not reach normal lifecycle admission")
	}
}

func TestNativeHTTPHealthListenerContainsOnlyLocalReadiness(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Second, fixtureSecurity())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler.HealthHandler())
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = time.Second
	t.Cleanup(client.CloseIdleConnections)
	for _, path := range []string{"/status", "/internal/runtimes"} {
		response, err := client.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		want := 404
		if path == "/status" {
			want = 200
			if !strings.Contains(string(raw), `"monitor_ready":true`) {
				t.Fatal("health projection lost monitor readiness")
			}
		}
		if err != nil || response.StatusCode != want {
			t.Fatalf("health %s: %d %s %v", path, response.StatusCode, raw, err)
		}
	}
}
