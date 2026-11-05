package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

func TestCommonErrorWorkloadBoundary(t *testing.T) {
	authentication, err := serviceauth.ParseReceiver("identity-service", []byte(`{"edge-gateway":["sha256:ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0"]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	handler, _, err := NewHandler(&probeStub{}, http.NotFoundHandler(), http.NotFoundHandler(), authentication)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/scim/v2/Users", nil))
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("failure body is not an object: %v", err)
	}
	if response.Code != 401 || body["code"] != "service_unauthenticated" || body["category"] != "unauthenticated" ||
		body["message"] != "Service authentication rejected" || body["retryable"] != false {
		t.Fatalf("envelope=%v status=%d", body, response.Code)
	}
	requestID, _ := body["request_id"].(string)
	if requestID == "" || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("request_id=%v header=%q", body["request_id"], response.Header().Get("X-Request-ID"))
	}
	if response.Header().Get("WWW-Authenticate") == "" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("challenge/no-store lost: %v", response.Header())
	}
}
