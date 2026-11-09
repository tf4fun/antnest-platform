package server

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

var updateGolden = flag.Bool("update", false, "rewrite captured control boundary golden documents")

func writeGoldenDocument(t *testing.T, path string, body []byte) {
	t.Helper()
	var document any
	require.NoError(t, json.Unmarshal(body, &document))
	pretty, err := json.MarshalIndent(document, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, append(pretty, '\n'), 0o644))
}

func TestControlBoundaryGolden(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	compiler := compileControlSchema(t, filepath.Join(root, "contracts/agent-controller/control-api.ids-v2.schema.json"))
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	agent := sampleControlAgent(now)
	operation := sampleControlOperation(now, agent.AgentID)
	event := sampleControlEvent(now, agent.AgentID, operation.RequestID)
	queries := &agentQueryServiceStub{
		agent: agent,
		page:  application.AgentPage{Items: []application.AgentView{agent}},
	}
	events := &agentEventServiceStub{
		page: application.AgentEventPage{Events: []application.AgentEventView{event}, NextSequence: 1},
	}
	boundary, err := newBusinessHandler(t,
		&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		queries, events, &networkPolicyServiceStub{}, func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new control boundary: %v", err)
	}
	for _, golden := range []struct {
		name      string
		resource  string
		operation string
	}{
		{name: "list-agents.ready", resource: "agents", operation: "list"},
		{name: "get-agent.ready", resource: "agents", operation: "get"},
		{name: "list-events.ready", resource: "events", operation: "list_global"},
	} {
		t.Run(golden.name, func(t *testing.T) {
			route, exists := contract.Resources[golden.resource][golden.operation]
			if !exists {
				t.Fatalf("control contract has no %s.%s", golden.resource, golden.operation)
			}
			if route.Method != http.MethodGet {
				t.Fatalf("%s.%s method = %s", golden.resource, golden.operation, route.Method)
			}
			if route.Request != "" || route.ContentType == "text/event-stream" {
				t.Fatalf("%s.%s is not a plain GET response boundary", golden.resource, golden.operation)
			}
			path := concreteControlPath(route.Path)
			if slices.Contains(route.Query, "organization_id") {
				path += "?organization_id=org-1"
			}
			request := httptest.NewRequest(route.Method, path, http.NoBody)
			request.Header.Set("Accept", contract.MediaTypes.Response)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, request)
			if response.Code != route.SuccessStatus {
				t.Fatalf("%s.%s status = %d want %d: %s",
					golden.resource, golden.operation, response.Code, route.SuccessStatus, response.Body.String())
			}
			body := response.Body.Bytes()
			assertControlResponseSchema(t, compiler, route.Response, body)
			file := filepath.Join(root, "contracts/agent-controller/examples", golden.name+".json")
			if *updateGolden {
				writeGoldenDocument(t, file, body)
			}
			expected, err := os.ReadFile(file)
			require.NoError(t, err)
			require.JSONEq(t, string(expected), string(body))
		})
	}
}

func TestLearningPolicyGolden(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	var precondition any
	readContractJSON(t, filepath.Join(root, "contracts/common/precondition.schema.json"), &precondition)
	commonIDs, err := os.ReadFile("../../../../contracts/common/ids.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	idsDocument, err := jsonschema.UnmarshalJSON(bytes.NewReader(commonIDs))
	if err != nil {
		t.Fatal(err)
	}
	if err := compiler.AddResource("https://schemas.antnest.dev/common/ids.schema.json", idsDocument); err != nil {
		t.Fatal(err)
	}
	require.NoError(t, compiler.AddResource("https://schemas.antnest.dev/common/precondition.schema.json", precondition))
	contract, err := os.ReadFile(filepath.Join(root, "contracts/skill-learning/learning-api.ids-v2.schema.json"))
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(contract))
	require.NoError(t, err)
	const identifier = "https://schemas.antnest.dev/skill-learning/learning-api.ids-v2.schema.json"
	require.NoError(t, compiler.AddResource(identifier, document))
	definition, err := compiler.Compile(identifier + "#/$defs/policy")
	require.NoError(t, err)

	policy := domain.DefaultSkillLearningPolicy("org-1", "agent-1", "owner-1", time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC))
	boundary, err := newBusinessLearningHandler(t, &learningPolicyServiceStub{policy: policy})
	if err != nil {
		t.Fatalf("new learning boundary: %v", err)
	}
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/skill-learning-policy?organization_id=org-1&principal_id=owner-1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("learning policy status = %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.Bytes()
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	require.NoError(t, err)
	require.NoError(t, definition.Validate(instance))
	file := filepath.Join(root, "contracts/skill-learning/examples/learning-policy.automatic.json")
	if *updateGolden {
		writeGoldenDocument(t, file, body)
	}
	expected, err := os.ReadFile(file)
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(body))
}
