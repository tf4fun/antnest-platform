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
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/repository/postgres"
	"soft/antnest-platform/services/agent-controller/internal/server"
)

func TestCatalogHappyPathThroughHTTPAndPostgres(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	resetE2ESchema(t, ctx, databaseURL)
	repository, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}
	eventNotifier, err := postgres.OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open Agent event notifier: %v", err)
	}
	t.Cleanup(eventNotifier.Close)
	secretBox, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatalf("create SecretBox: %v", err)
	}
	handler, err := server.NewHandler(
		application.NewCatalogService(repository, secretBox, fixedClock{now: time.Unix(1, 0).UTC()}),
		catalogOnlyLifecycle{},
		application.NewRunService(
			repository, secretBox, fixedClock{now: time.Unix(1, 0).UTC()}, 30*time.Minute,
		),
		application.NewAgentQueryService(repository, application.WithWorkspaceStateNotifier(eventNotifier)),
		application.NewEventService(repository, eventNotifier, repository),
		catalogOnlyNetworkPolicy{},
		repository.Ping,
	)
	if err != nil {
		t.Fatalf("create handler: %v", err)
	}

	assertProviderManagement(t, handler)
	assertModelEditConcurrency(t, handler)
	provider := createTestProvider(t, handler, "catalog-e2e-provider", "catalog-e2e-org", "https://api.example.com/v1", "catalog-e2e-secret")
	modelResponse := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", `{
      "request_id":"catalog-e2e-model",
      "organization_id":"catalog-e2e-org",
      "profile_key":"deepseek",
      "display_name":"DeepSeek",
      "model":{
        "model":"deepseek-chat",
        "context_window":128000,
        "max_output_tokens":8192,
        "supports_images":false
      },
      "provider_connection_id":"`+provider["connection_id"].(string)+`"
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
      "model_profile_id":"` + modelResponse["model_profile_id"].(string) + `",
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
	assertImageChoicePublication(t, handler, templateRequest)
	assertModelPricingPublication(t, handler)
}

func assertImageChoicePublication(t *testing.T, handler http.Handler, original string) {
	t.Helper()
	var draft map[string]any
	if err := json.Unmarshal([]byte(original), &draft); err != nil {
		t.Fatal(err)
	}
	draft["request_id"], draft["template_key"] = "catalog-image-choice", "image-choice"
	runtime := draft["runtime"].(map[string]any)
	runtime["image_ref"] = "antnest/runtime:latest"
	body := mustJSON(t, draft)
	created := serveJSON(t, handler, http.MethodPost, "/internal/agent-templates", body, http.StatusCreated)
	path := "/internal/agent-templates/" + created["template_id"].(string)
	persisted := serveJSON(t, handler, http.MethodGet, path+"?organization_id=catalog-e2e-org", "", http.StatusOK)
	image := persisted["runtime"].(map[string]any)
	if image["image_ref"] != runtime["image_ref"] || image["image_source"] != nil {
		t.Fatalf("persisted Runtime changed the submitted reference: %+v", image)
	}
	replayed := serveJSON(t, handler, http.MethodPost, "/internal/agent-templates", body, http.StatusCreated)
	for _, field := range []string{"created_at", "updated_at"} {
		instant, err := time.Parse(time.RFC3339Nano, replayed[field].(string))
		if err != nil {
			t.Fatal(err)
		}
		replayed[field] = instant.UTC().Format(time.RFC3339Nano)
	}
	if mustJSON(t, replayed) != mustJSON(t, created) {
		t.Fatalf("replay changed: created=%s replayed=%s", mustJSON(t, created), mustJSON(t, replayed))
	}
	delete(draft, "template_key")
	draft["request_id"], draft["system_prompt"] = "catalog-image-preserve", "Updated prompt"
	revised := serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusCreated)
	if revised["runtime"].(map[string]any)["image_ref"] != runtime["image_ref"] || revised["revision"] != float64(2) {
		t.Fatal("prompt-only revision changed the image reference")
	}
	draft["request_id"], runtime["image_ref"] = "catalog-image-unavailable", "missing.example/runtime:latest"
	revised = serveJSON(t, handler, http.MethodPost, path+"/revisions", mustJSON(t, draft), http.StatusCreated)
	current := serveJSON(t, handler, http.MethodGet, path+"?organization_id=catalog-e2e-org", "", http.StatusOK)
	if current["revision"] != revised["revision"] || current["runtime"].(map[string]any)["image_ref"] != runtime["image_ref"] {
		t.Fatal("unavailable image prevented publication or changed the reference")
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

type catalogOnlyNetworkPolicy struct{}

func (catalogOnlyNetworkPolicy) GetAgentNetworkPolicy(context.Context, string, string) (application.AgentNetworkPolicyView, error) {
	return application.AgentNetworkPolicyView{}, application.ErrDependencyUnavailable
}

func (catalogOnlyNetworkPolicy) SetAgentNetworkPolicy(context.Context, application.SetAgentNetworkPolicyInput) (ports.NetworkPolicyAssignment, error) {
	return ports.NetworkPolicyAssignment{}, application.ErrDependencyUnavailable
}

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

func (catalogOnlyLifecycle) RebuildAgent(
	context.Context, application.RebuildAgentInput,
) (application.RebuildAgentResult, error) {
	return application.RebuildAgentResult{}, application.ErrDependencyUnavailable
}

func (catalogOnlyLifecycle) DisableAgent(
	context.Context, application.DisableAgentInput,
) (application.DisableAgentResult, error) {
	return application.DisableAgentResult{}, application.ErrDependencyUnavailable
}

func (catalogOnlyLifecycle) EnableAgent(
	context.Context, application.EnableAgentInput,
) (application.EnableAgentResult, error) {
	return application.EnableAgentResult{}, application.ErrDependencyUnavailable
}

func (catalogOnlyLifecycle) DeleteAgent(
	context.Context, application.DeleteAgentInput,
) (application.DeleteAgentResult, error) {
	return application.DeleteAgentResult{}, application.ErrDependencyUnavailable
}
