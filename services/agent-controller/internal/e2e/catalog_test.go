package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/repository/postgres"
	"soft/antnest-platform/services/agent-controller/internal/server"
)

func TestCatalogHappyPathThroughHTTPAndPostgres(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}
	secretBox, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatalf("create SecretBox: %v", err)
	}
	handler, err := server.NewHandler(
		application.NewCatalogService(repository, secretBox, fixedClock{now: time.Unix(1, 0).UTC()}),
		catalogOnlyLifecycle{},
		repository.Ping,
	)
	if err != nil {
		t.Fatalf("create handler: %v", err)
	}

	modelResponse := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", `{
      "request_id":"catalog-e2e-model",
      "organization_id":"catalog-e2e-org",
      "profile_key":"deepseek",
      "display_name":"DeepSeek",
      "model":{
        "base_url":"https://api.example.com/v1",
        "model":"deepseek-chat",
        "context_window":128000,
        "max_output_tokens":8192,
        "supports_images":false
      },
      "credential":{"secret_type":"bearer","secret":"catalog-e2e-secret"}
    }`, http.StatusCreated)
	revisionID, ok := modelResponse["revision_id"].(string)
	if !ok || revisionID == "" {
		t.Fatalf("ModelProfile response lacks revision identity: %+v", modelResponse)
	}
	if strings.Contains(mustJSON(t, modelResponse), "catalog-e2e-secret") {
		t.Fatal("ModelProfile response leaked the Provider secret")
	}

	templateRequest := `{
      "request_id":"catalog-e2e-template",
      "organization_id":"catalog-e2e-org",
      "template_key":"personal",
      "name":"Personal Agent",
      "model_profile_revision_id":"` + revisionID + `",
      "system_prompt":"You are helpful.",
      "max_model_requests":16,
      "context_policy_version":"context-v1",
      "runtime":{
        "image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "resources":{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864}
      }
    }`
	templateResponse := serveJSON(
		t, handler, http.MethodPost, "/internal/agent-templates", templateRequest, http.StatusCreated,
	)
	if templateResponse["revision"] != float64(1) {
		t.Fatalf("Template response = %+v", templateResponse)
	}
	listResponse := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agent-templates?organization_id=catalog-e2e-org&limit=10", "", http.StatusOK,
	)
	items, ok := listResponse["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("Template list response = %+v", listResponse)
	}
}

func serveJSON(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body string,
	expectedStatus int,
) map[string]any {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("%s %s status=%d body=%s", method, path, response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %s %s response: %v", method, path, err)
	}
	return payload
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode JSON: %v", err)
	}
	return string(payload)
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

type catalogOnlyLifecycle struct{}

func (catalogOnlyLifecycle) GetLifecycleOperation(
	context.Context, string,
) (application.OperationView, error) {
	return application.OperationView{}, application.ErrDependencyUnavailable
}

func (catalogOnlyLifecycle) CreateAgent(
	context.Context, application.CreateAgentInput,
) (application.CreateAgentResult, error) {
	return application.CreateAgentResult{}, application.ErrDependencyUnavailable
}
